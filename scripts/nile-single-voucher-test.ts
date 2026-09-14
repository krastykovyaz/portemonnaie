// Single $1 real TRON Nile testnet voucher redemption — for manual smoke
// testing without spending a full $10 minimum voucher through the UI.
//
// Drives the EXACT same service-layer functions the app's HTTP/browser flow
// uses (createBatch -> assignVouchers -> markVoucherSold -> redeemVoucher),
// which internally goes through createPayoutForRedemption -> drivePayout ->
// the real TronTestnetPayoutSigner. Never calls the signer directly, never
// touches private keys.
//
// This does NOT change DENOMINATIONS or any pricing config in the app --
// createBatch() itself accepts any denomination; only the admin UI's
// createBatchFn restricts you to the public price list. This script bypasses
// that UI-only restriction for a single test voucher, nothing else.
//
// SAFETY: aborts immediately unless CHAIN_MODE=TESTNET, TRON_NETWORK=NILE,
// PAYOUT_SIGNER=TRON_TESTNET are all set exactly as expected, and requires
// an explicit destination address (never generates or guesses one).
//
// Usage:
//   TEST_DESTINATION_ADDRESS=TYourNileAddressHere bun run scripts/nile-single-voucher-test.ts

import { TronWeb } from "tronweb";
import { db } from "@/lib/db/client";
import { createBatch, assignVouchers, markVoucherSold } from "@/lib/services/voucher.server";
import { redeemVoucher } from "@/lib/services/redemption.server";
import { processPayout } from "@/lib/services/payout.server";
import { resolveRuntime } from "@/lib/providers/registry.server";

// ---- Safety gate ----
if (process.env["CHAIN_MODE"] !== "TESTNET") {
  console.error("ABORT: CHAIN_MODE is not TESTNET");
  process.exit(1);
}
if ((process.env["TRON_NETWORK"] ?? "").toUpperCase() !== "NILE") {
  console.error("ABORT: TRON_NETWORK is not NILE");
  process.exit(1);
}
if (process.env["PAYOUT_SIGNER"] !== "TRON_TESTNET") {
  console.error("ABORT: PAYOUT_SIGNER is not TRON_TESTNET");
  process.exit(1);
}
const runtime = resolveRuntime();
if (runtime.payoutProvider.simulated || runtime.payoutBlockers.length > 0) {
  console.error("ABORT: real payout provider not active", runtime.payoutBlockers);
  process.exit(1);
}

const destination = process.env["TEST_DESTINATION_ADDRESS"];
if (!destination) {
  console.error(
    "ABORT: TEST_DESTINATION_ADDRESS is not set. Provide a real Nile testnet TRON address you control " +
      "(e.g. a TronLink wallet switched to the Nile network) so you can independently verify receipt.",
  );
  process.exit(1);
}

const DENOMINATION = Number(process.env["TEST_DENOMINATION"] ?? 1);
const TRONGRID = "https://nile.trongrid.io";

console.log("Safety gate passed. Provider:", runtime.payoutProvider.id);
console.log("Destination:", destination);
console.log("Denomination:", DENOMINATION, "USDT");

async function findAdminUserId(): Promise<string> {
  const row = db.query(`SELECT id FROM users WHERE email = 'admin3@demo.test'`).get() as
    | { id: string }
    | undefined;
  if (!row) throw new Error("admin3@demo.test not found — run seed first");
  return row.id;
}

async function findAgentId(): Promise<string> {
  const row = db.query(`SELECT id FROM agents WHERE agent_ref = 'AGT-A'`).get() as
    | { id: string }
    | undefined;
  if (!row) throw new Error("AGT-A agent not found");
  return row.id;
}

async function fetchTronTxInfo(txHash: string) {
  const res = await fetch(`${TRONGRID}/wallet/gettransactioninfobyid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: txHash }),
  });
  return (await res.json()) as {
    id?: string;
    blockNumber?: number;
    receipt?: { result?: string; energy_usage_total?: number; net_usage?: number };
  };
}

async function main() {
  const adminUserId = await findAdminUserId();
  const agentId = await findAgentId();

  console.log("\n--- Issuing 1 test voucher ---");
  const { codes } = await createBatch({
    denomination: DENOMINATION,
    quantity: 1,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    actorId: adminUserId,
    actorLabel: "nile-single-voucher-test-script",
  });
  const code = codes[0]!;
  console.log("Voucher:", code.public_id, "code:", code.code);

  const voucherRow = db.query(`SELECT id FROM vouchers WHERE public_id = ?`).get(code.public_id) as {
    id: string;
  };

  await assignVouchers({
    voucherIds: [voucherRow.id],
    agentId,
    actorId: adminUserId,
    actorLabel: "nile-single-voucher-test-script",
  });
  await markVoucherSold({
    voucherId: voucherRow.id,
    agentId,
    actorId: adminUserId,
    actorLabel: "nile-single-voucher-test-script",
  });
  console.log("Voucher marked SOLD.");

  console.log("\n--- Redeeming to", destination, "---");
  const outcome = await redeemVoucher({
    publicId: code.public_id,
    code: code.code,
    destination,
    userId: null,
  });
  console.log("redeemVoucher() result:", JSON.stringify(outcome, null, 2));

  let payoutRow = db
    .query(`SELECT id, status, tx_hash, confirmations, failure_reason FROM payouts WHERE voucher_id = ?`)
    .get(voucherRow.id) as
    | { id: string; status: string; tx_hash: string | null; confirmations: number; failure_reason: string | null }
    | undefined;

  if (!payoutRow) {
    console.error("No payout row was created — aborting.");
    return;
  }

  // Sweep a few times if it's still confirming (BROADCAST/CONFIRMING).
  for (let pass = 0; pass < 10 && !["CONFIRMED", "MANUAL_REVIEW", "FAILED"].includes(payoutRow.status); pass++) {
    console.log(`Sweep pass ${pass + 1}: status=${payoutRow.status}, waiting 6s...`);
    await new Promise((r) => setTimeout(r, 6000));
    const record = {
      id: payoutRow.id,
      redemptionId: "", // not needed by processPayout's confirm path
      voucherId: voucherRow.id,
      idempotencyKey: "",
      amount: DENOMINATION,
      token: "USDT",
      network: "TRON_TESTNET",
      destination,
      status: payoutRow.status as import("@/lib/payout/state-machine").PayoutStatus,
      txHash: payoutRow.tx_hash,
      confirmations: payoutRow.confirmations,
      attemptCount: 0,
      maxAttempts: 3,
      failureReason: payoutRow.failure_reason,
    };
    try {
      await processPayout(record);
    } catch (err) {
      console.error("Sweep error:", err instanceof Error ? err.message : err);
    }
    payoutRow = db
      .query(`SELECT id, status, tx_hash, confirmations, failure_reason FROM payouts WHERE voucher_id = ?`)
      .get(voucherRow.id) as typeof payoutRow;
  }

  console.log("\n--- Final payout state ---");
  console.log(JSON.stringify(payoutRow, null, 2));

  if (payoutRow?.tx_hash) {
    console.log("\nIndependent on-chain check via TronGrid...");
    const chain = await fetchTronTxInfo(payoutRow.tx_hash);
    console.log(JSON.stringify(chain, null, 2));
    console.log(`\nVerify yourself at: https://nile.tronscan.org/#/transaction/${payoutRow.tx_hash}`);
  } else {
    console.log("\nNo tx hash yet — check the payout row above for failure_reason.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
