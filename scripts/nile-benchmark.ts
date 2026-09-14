// Real TRON Nile testnet payout cost benchmark.
//
// Drives the EXACT same service-layer functions the app's HTTP/browser flow
// uses (createBatch -> assignVouchers -> markVoucherSold -> redeemVoucher),
// which internally goes through createPayoutForRedemption -> drivePayout ->
// the real TronTestnetPayoutSigner. This script never calls the signer
// directly and never touches private keys.
//
// SAFETY: aborts immediately unless CHAIN_MODE=TESTNET, TRON_NETWORK=NILE,
// PAYOUT_SIGNER=TRON_TESTNET are all set exactly as expected.

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
console.log("Safety gate passed. Provider:", runtime.payoutProvider.id);

const TRONGRID = "https://nile.trongrid.io";
const USDT_CONTRACT = process.env["USDT_CONTRACT_ADDRESS"]!;
const TREASURY = process.env["TREASURY_ADDRESS"]!;
const FRESH_COUNT = Number(process.env["BENCH_FRESH"] ?? 50);
const EXISTING_COUNT = Number(process.env["BENCH_EXISTING"] ?? 50);
const EXISTING_POOL = ["TXLGad17PxfSqzqrMY2jm6Bc6n1eWNRHdp", "TX1j3dcV5p7XMiV3UiWTmJs339jExoVGhm"];

const tw = new TronWeb({ fullHost: TRONGRID });

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

type Recipient = { address: string; kind: "fresh" | "existing" };

async function buildRecipients(): Promise<Recipient[]> {
  const list: Recipient[] = [];
  for (let i = 0; i < FRESH_COUNT; i++) {
    const acct = await tw.createAccount();
    list.push({ address: acct.address.base58, kind: "fresh" });
  }
  for (let i = 0; i < EXISTING_COUNT; i++) {
    list.push({ address: EXISTING_POOL[i % EXISTING_POOL.length]!, kind: "existing" });
  }
  return list;
}

type PayoutRecordResult = {
  index: number;
  kind: "fresh" | "existing";
  recipient: string;
  voucherPublicId: string;
  payoutId: string | null;
  broadcastOutcomeStatus: string;
  error: string | null;
};

async function runOne(
  adminUserId: string,
  agentId: string,
  index: number,
  recipient: Recipient,
): Promise<PayoutRecordResult> {
  try {
    const { codes } = await createBatch({
      denomination: 10,
      quantity: 1,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      actorId: adminUserId,
      actorLabel: "nile-benchmark-script",
    });
    const code = codes[0]!;
    const voucherRow = db
      .query(`SELECT id FROM vouchers WHERE public_id = ?`)
      .get(code.public_id) as { id: string };

    await assignVouchers({
      voucherIds: [voucherRow.id],
      agentId,
      actorId: adminUserId,
      actorLabel: "nile-benchmark-script",
    });
    await markVoucherSold({
      voucherId: voucherRow.id,
      agentId,
      actorId: adminUserId,
      actorLabel: "nile-benchmark-script",
    });

    const outcome = await redeemVoucher({
      publicId: code.public_id,
      code: code.code,
      destination: recipient.address,
      userId: null,
    });

    const payoutRow = db
      .query(`SELECT id, status FROM payouts WHERE voucher_id = ?`)
      .get(voucherRow.id) as { id: string; status: string } | undefined;

    return {
      index,
      kind: recipient.kind,
      recipient: recipient.address,
      voucherPublicId: code.public_id,
      payoutId: payoutRow?.id ?? null,
      broadcastOutcomeStatus: payoutRow?.status ?? (outcome.ok ? "CONFIRMED" : "UNKNOWN"),
      error: outcome.ok ? null : outcome.error,
    };
  } catch (err) {
    return {
      index,
      kind: recipient.kind,
      recipient: recipient.address,
      voucherPublicId: "",
      payoutId: null,
      broadcastOutcomeStatus: "EXCEPTION",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function sweepUntilDone(payoutIds: string[], maxPasses = 20, delayMs = 6000) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const pending = db
      .query(
        `SELECT id, redemption_id, voucher_id, idempotency_key, amount, token, network, destination_address,
                status, tx_hash, confirmations, attempt_count, max_attempts, failure_reason
         FROM payouts WHERE id IN (${payoutIds.map(() => "?").join(",")}) AND status NOT IN ('CONFIRMED','MANUAL_REVIEW')`,
      )
      .all(...payoutIds) as Array<Record<string, unknown>>;
    if (pending.length === 0) {
      console.log(`Sweep pass ${pass + 1}: all done.`);
      return;
    }
    console.log(`Sweep pass ${pass + 1}: ${pending.length} still pending...`);
    for (const row of pending) {
      const record = {
        id: String(row["id"]),
        redemptionId: String(row["redemption_id"]),
        voucherId: String(row["voucher_id"]),
        idempotencyKey: String(row["idempotency_key"]),
        amount: Number(row["amount"]),
        token: String(row["token"]),
        network: String(row["network"]),
        destination: String(row["destination_address"]),
        status: row["status"] as import("@/lib/payout/state-machine").PayoutStatus,
        txHash: (row["tx_hash"] as string | null) ?? null,
        confirmations: Number(row["confirmations"] ?? 0),
        attemptCount: Number(row["attempt_count"] ?? 0),
        maxAttempts: Number(row["max_attempts"] ?? 3),
        failureReason: (row["failure_reason"] as string | null) ?? null,
      };
      try {
        await processPayout(record);
      } catch (err) {
        console.error(`  payout ${record.id} sweep error:`, err instanceof Error ? err.message : err);
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log("Sweep: max passes reached, some payouts may still be pending.");
}

async function fetchTronTxInfo(txHash: string): Promise<{
  found: boolean;
  result: string | null;
  blockNumber: number | null;
  energyUsageTotal: number;
  netUsage: number;
  netFee: number;
  energyFee: number;
  recipientHex: string | null;
  amountRaw: string | null;
}> {
  const res = await fetch(`${TRONGRID}/wallet/gettransactioninfobyid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: txHash }),
  });
  const info = (await res.json()) as {
    id?: string;
    blockNumber?: number;
    receipt?: {
      result?: string;
      energy_usage_total?: number;
      net_usage?: number;
      net_fee?: number;
      energy_fee?: number;
    };
    log?: Array<{ topics?: string[]; data?: string }>;
  };
  if (!info || !info.id) {
    return {
      found: false,
      result: null,
      blockNumber: null,
      energyUsageTotal: 0,
      netUsage: 0,
      netFee: 0,
      energyFee: 0,
      recipientHex: null,
      amountRaw: null,
    };
  }
  const log = info.log?.[0];
  return {
    found: true,
    result: info.receipt?.result ?? "SUCCESS",
    blockNumber: info.blockNumber ?? null,
    energyUsageTotal: info.receipt?.energy_usage_total ?? 0,
    netUsage: info.receipt?.net_usage ?? 0,
    netFee: info.receipt?.net_fee ?? 0,
    energyFee: info.receipt?.energy_fee ?? 0,
    recipientHex: log?.topics?.[2] ?? null,
    amountRaw: log?.data ?? null,
  };
}

async function main() {
  const adminUserId = await findAdminUserId();
  const agentId = await findAgentId();
  const recipients = await buildRecipients();
  console.log(`Built ${recipients.length} recipients (${FRESH_COUNT} fresh, ${EXISTING_COUNT} existing).`);

  const results: PayoutRecordResult[] = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = await runOne(adminUserId, agentId, i, recipients[i]!);
    results.push(r);
    console.log(
      `[${i + 1}/${recipients.length}] ${r.kind} ${r.recipient.slice(0, 8)}… voucher=${r.voucherPublicId} status=${r.broadcastOutcomeStatus} ${r.error ? "ERROR:" + r.error : ""}`,
    );
  }

  const payoutIds = results.map((r) => r.payoutId).filter((x): x is string => !!x);
  console.log(`\nBroadcast phase done. ${payoutIds.length} payouts created. Starting confirmation sweep...`);
  await sweepUntilDone(payoutIds);

  console.log("\nIndependent on-chain verification...");
  const finalRows = db
    .query(
      `SELECT id, voucher_id, destination_address, amount, status, tx_hash, confirmations FROM payouts WHERE id IN (${payoutIds.map(() => "?").join(",")})`,
    )
    .all(...payoutIds) as Array<{
    id: string;
    voucher_id: string;
    destination_address: string;
    amount: number;
    status: string;
    tx_hash: string | null;
    confirmations: number;
  }>;

  const enriched: Array<{
    payoutId: string;
    kind: "fresh" | "existing";
    recipient: string;
    amount: number;
    dbStatus: string;
    txHash: string | null;
    onChain: Awaited<ReturnType<typeof fetchTronTxInfo>>;
    recipientMatches: boolean;
    amountMatches: boolean;
  }> = [];

  for (const row of finalRows) {
    const orig = results.find((r) => r.payoutId === row.id)!;
    if (!row.tx_hash) {
      enriched.push({
        payoutId: row.id,
        kind: orig.kind,
        recipient: row.destination_address,
        amount: row.amount,
        dbStatus: row.status,
        txHash: null,
        onChain: {
          found: false,
          result: null,
          blockNumber: null,
          energyUsageTotal: 0,
          netUsage: 0,
          netFee: 0,
          energyFee: 0,
          recipientHex: null,
          amountRaw: null,
        },
        recipientMatches: false,
        amountMatches: false,
      });
      continue;
    }
    const chain = await fetchTronTxInfo(row.tx_hash);
    let recipientMatches = false;
    if (chain.recipientHex) {
      try {
        const decoded = TronWeb.address.fromHex("41" + chain.recipientHex.slice(-40));
        recipientMatches = decoded === row.destination_address;
      } catch {
        recipientMatches = false;
      }
    }
    const amountMatches = chain.amountRaw
      ? BigInt("0x" + chain.amountRaw) === BigInt(Math.round(row.amount * 1e6))
      : false;
    enriched.push({
      payoutId: row.id,
      kind: orig.kind,
      recipient: row.destination_address,
      amount: row.amount,
      dbStatus: row.status,
      txHash: row.tx_hash,
      onChain: chain,
      recipientMatches,
      amountMatches,
    });
    await new Promise((r) => setTimeout(r, 120)); // be polite to the public API
  }

  // Final treasury balances
  const treasuryInfo = (await (
    await fetch(`${TRONGRID}/v1/accounts/${TREASURY}`)
  ).json()) as { data: Array<{ balance: number; trc20?: Array<Record<string, string>> }> };
  const trxBalance = (treasuryInfo.data?.[0]?.balance ?? 0) / 1e6;
  const usdtRaw = treasuryInfo.data?.[0]?.trc20?.find((t) => USDT_CONTRACT in t)?.[USDT_CONTRACT];
  const usdtBalance = usdtRaw ? Number(usdtRaw) / 1e6 : null;

  const outPath = "/tmp/nile-benchmark-result.json";
  await Bun.write(
    outPath,
    JSON.stringify(
      {
        summary: { fresh: FRESH_COUNT, existing: EXISTING_COUNT, treasury: TREASURY, contract: USDT_CONTRACT },
        results: enriched,
        finalTreasury: { trxBalance, usdtBalance },
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote full results to ${outPath}`);
  console.log("Final treasury TRX:", trxBalance, "USDT:", usdtBalance);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
