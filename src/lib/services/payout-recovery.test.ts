import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, newId, nowIso } from "@/lib/db/client";
import { createPayoutForRedemption, payoutClaimBatch } from "@/lib/db/procedures/payouts";
import { startRedemption } from "@/lib/db/procedures/redemption";
import { supabasePayoutStore } from "./payout-store.server";
import { processPayout } from "./payout.server";

// Ends in 'p': the mock provider's SUCCESS scenario (F/S/T/X trigger failure modes).
const DEST = "TXLGad17PxfSqzqrMY2jm6Bc6n1eWNRHdp";

let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env["CHAIN_MODE"];
  process.env["CHAIN_MODE"] = "DEMO";
});
afterEach(() => {
  if (savedMode === undefined) delete process.env["CHAIN_MODE"];
  else process.env["CHAIN_MODE"] = savedMode;
});

function pendingPayout(): { payoutId: string; voucherId: string } {
  const id = newId();
  const publicId = `TESTR${id.slice(0, 10)}`;
  const codeHash = `hash_${id}`;
  const now = nowIso();
  db.query(
    `INSERT INTO vouchers (id, public_id, code_hash, asset, network, denomination, status, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, 'USDT', 'TRON_TESTNET', 25, 'SOLD', ?, ?, ?)`,
  ).run(id, publicId, codeHash, now, new Date(Date.now() + 3_600_000).toISOString(), now);
  const start = startRedemption({ publicId, codeHash, destination: DEST });
  if (!start.ok) throw new Error(start.error);
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
  });
  return { payoutId, voucherId: start.voucher_id };
}

describe("recovery path (processPayout as the sweep and admin retry use it)", () => {
  it("a PENDING payout is claimable by the sweep and driven to CONFIRMED, finalizing the voucher", async () => {
    const { payoutId, voucherId } = pendingPayout();

    const claimed = payoutClaimBatch("test-worker", 1_000) as Array<{ id: string }>;
    expect(claimed.some((row) => row.id === payoutId)).toBe(true);

    const record = await supabasePayoutStore.load(payoutId);
    expect(record?.status).toBe("PENDING");
    const outcome = await processPayout(record!);
    expect(outcome.status).toBe("CONFIRMED");
    expect(outcome.txHash).toBeTruthy();

    const voucher = db.query(`SELECT status FROM vouchers WHERE id = ?`).get(voucherId) as { status: string };
    expect(voucher.status).toBe("REDEEMED");

    // Terminal now — the next sweep leaves it alone.
    const again = payoutClaimBatch("test-worker", 1_000) as Array<{ id: string }>;
    expect(again.some((row) => row.id === payoutId)).toBe(false);
  });

  it("re-driving a CONFIRMED payout replays without a second broadcast", async () => {
    const { payoutId } = pendingPayout();
    const first = await processPayout((await supabasePayoutStore.load(payoutId))!);
    expect(first.status).toBe("CONFIRMED");
    const second = await processPayout((await supabasePayoutStore.load(payoutId))!);
    expect(second.status).toBe("CONFIRMED");
    expect(second.replayed).toBe(true);
    expect(second.txHash).toBe(first.txHash);
  });
});
