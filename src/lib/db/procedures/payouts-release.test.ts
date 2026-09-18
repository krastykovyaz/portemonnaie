import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, newId, nowIso } from "../client";
import { startRedemption } from "./redemption";
import {
  createPayoutForRedemption,
  payoutClaimBatch,
  payoutManualReview,
  payoutMarkBroadcast,
  payoutReleaseVoucher,
} from "./payouts";
import { releaseStuckVoucher } from "@/lib/services/payout.server";

const DEST = "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF";

function insertSoldVoucher(): { publicId: string; codeHash: string } {
  const id = newId();
  const publicId = `TESTV${id.slice(0, 10)}`;
  const codeHash = `hash_${id}`;
  const now = nowIso();
  db.query(
    `INSERT INTO vouchers (id, public_id, code_hash, asset, network, denomination, status, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, 'USDT', 'TRON_TESTNET', 25, 'SOLD', ?, ?, ?)`,
  ).run(id, publicId, codeHash, now, new Date(Date.now() + 3_600_000).toISOString(), now);
  return { publicId, codeHash };
}

function pendingPayout() {
  const { publicId, codeHash } = insertSoldVoucher();
  const start = startRedemption({ publicId, codeHash, destination: DEST });
  if (!start.ok) throw new Error(`fixture: ${start.error}`);
  const payoutId = createPayoutForRedemption({
    redemptionId: start.redemption_id,
    voucherId: start.voucher_id,
    transactionId: start.transaction_id,
    userId: null,
    amount: start.amount,
    network: start.network,
    token: start.asset,
    destination: DEST,
    idempotencyKey: start.redemption_id,
    provider: "tron-testnet-signer",
  });
  return { payoutId, voucherId: start.voucher_id };
}

function voucherStatus(voucherId: string): string {
  return (db.query(`SELECT status FROM vouchers WHERE id = ?`).get(voucherId) as { status: string })
    .status;
}

describe("payoutReleaseVoucher — no second transfer while the first may have settled", () => {
  it("releases a payout that never broadcast (no tx hash): voucher goes back to SOLD", () => {
    const { payoutId, voucherId } = pendingPayout();
    const result = payoutReleaseVoucher({ payoutId, reason: "stuck", actorLabel: "test" });
    expect(result.ok).toBe(true);
    expect(voucherStatus(voucherId)).toBe("SOLD");
  });

  it("refuses to release a BROADCAST payout with a tx hash unless the chain failure is verified", () => {
    const { payoutId, voucherId } = pendingPayout();
    payoutMarkBroadcast(payoutId, `tx_${newId()}`);

    const refused = payoutReleaseVoucher({ payoutId, reason: "stuck", actorLabel: "test" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe("TX_NOT_PROVEN_FAILED");
    // Voucher must stay REDEEMING — releasing it would let a second, real
    // transfer be created under a fresh idempotency key.
    expect(voucherStatus(voucherId)).toBe("REDEEMING");

    const allowed = payoutReleaseVoucher({
      payoutId,
      reason: "reverted on chain",
      actorLabel: "test",
      chainFailureVerified: true,
    });
    expect(allowed.ok).toBe(true);
    expect(voucherStatus(voucherId)).toBe("SOLD");
  });

  it("still refuses an already-CONFIRMED payout regardless of the verification flag", () => {
    const { payoutId } = pendingPayout();
    payoutMarkBroadcast(payoutId, `tx_${newId()}`);
    db.query(`UPDATE payouts SET status = 'CONFIRMED' WHERE id = ?`).run(payoutId);
    const result = payoutReleaseVoucher({
      payoutId,
      reason: "x",
      actorLabel: "test",
      chainFailureVerified: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ALREADY_CONFIRMED");
  });

  it("a MANUAL_REVIEW payout is not re-claimed by the recovery sweep", () => {
    const { payoutId } = pendingPayout();
    payoutManualReview({ payoutId, reason: "PROVIDER_REPORTED_FAILED", actorLabel: "test" });
    const claimed = payoutClaimBatch("test-worker", 500) as Array<{ id: string }>;
    expect(claimed.some((row) => row.id === payoutId)).toBe(false);
  });
});

describe("releaseStuckVoucher (service) — asks the chain before releasing", () => {
  let savedMode: string | undefined;
  beforeEach(() => {
    savedMode = process.env["CHAIN_MODE"];
    process.env["CHAIN_MODE"] = "DEMO";
  });
  afterEach(() => {
    if (savedMode === undefined) delete process.env["CHAIN_MODE"];
    else process.env["CHAIN_MODE"] = savedMode;
  });

  it("refuses when the provider has no record of the broadcast hash (unknown != failed)", async () => {
    const { payoutId, voucherId } = pendingPayout();
    payoutMarkBroadcast(payoutId, `tx_unknown_${newId()}`);

    const result = await releaseStuckVoucher({
      payoutId,
      reason: "stuck",
      actorId: null,
      actorLabel: "admin",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("TX_NOT_PROVEN_FAILED");
    expect(voucherStatus(voucherId)).toBe("REDEEMING");
  });

  it("releases when there was never a broadcast", async () => {
    const { payoutId, voucherId } = pendingPayout();
    const result = await releaseStuckVoucher({
      payoutId,
      reason: "never sent",
      actorId: null,
      actorLabel: "admin",
    });
    expect(result.ok).toBe(true);
    expect(voucherStatus(voucherId)).toBe("SOLD");
  });
});
