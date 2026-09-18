import { db } from "@/lib/db/client";
import {
  setPayoutsEnabled as setPayoutsEnabledProc,
  payoutClaimBatch,
  payoutRetry,
  payoutManualReview,
  payoutReleaseVoucher,
} from "@/lib/db/procedures/payouts";
import { resolveRuntime } from "../providers/registry.server";
import { drivePayout, type PayoutOutcome, type PayoutRecord } from "../payout/orchestrator";
import { PAYOUT_STATUS_LABELS, type PayoutStatus } from "../payout/state-machine";
import { supabasePayoutStore, toRecord, type PayoutRow } from "./payout-store.server";
import { writeAudit } from "./audit.server";

/** Structured server-side log line — one JSON object per payout event. */
export function payoutLog(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ scope: "payout", event, at: new Date().toISOString(), ...fields }));
}

export async function processPayout(payout: PayoutRecord): Promise<PayoutOutcome> {
  // Resolved fresh per call, same as the payment gateway/signer elsewhere in
  // this file's siblings — DEMO and un-opted-in TESTNET keep getting the
  // mock; only CHAIN_MODE=TESTNET + PAYOUT_SIGNER=TRON_TESTNET (validated)
  // gets the real signer. See registry.server.ts's resolvePayoutProvider.
  const runtime = resolveRuntime();
  return drivePayout(payout, {
    provider: runtime.payoutProvider,
    store: supabasePayoutStore,
    log: payoutLog,
  });
}

export async function getPayoutSettings() {
  const row = db
    .query(`SELECT payouts_enabled, paused_reason, updated_at FROM payout_settings WHERE id = 1`)
    .get() as { payouts_enabled: number; paused_reason: string | null; updated_at: string } | null;
  return {
    payoutsEnabled: row ? row.payouts_enabled === 1 : true,
    pausedReason: row?.paused_reason ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function setPayoutsEnabled(input: {
  enabled: boolean;
  reason?: string | null;
  actorId: string | null;
  actorLabel: string;
}) {
  setPayoutsEnabledProc(input);
  payoutLog(input.enabled ? "settings.resumed" : "settings.paused", {
    actor: input.actorLabel,
    reason: input.reason ?? null,
  });
  return getPayoutSettings();
}

export type PayoutListItem = {
  id: string;
  voucher_public_id: string | null;
  amount: number;
  token: string;
  network: string;
  destination_address: string;
  tx_hash: string | null;
  status: PayoutStatus;
  status_label: string;
  confirmations: number;
  attempt_count: number;
  max_attempts: number;
  failure_reason: string | null;
  scenario: string;
  /** e.g. 'mock-tron-testnet' (simulated) vs 'tron-testnet-signer' (real). */
  provider: string;
  /** True for anything other than the real signer — i.e. still simulated. */
  simulated: boolean;
  created_at: string;
  confirmed_at: string | null;
  voucher_status: string | null;
};

export async function listPayouts(filter: { status?: string } = {}): Promise<PayoutListItem[]> {
  const status = filter.status && filter.status !== "ALL" ? filter.status : null;
  const rows = db
    .query(
      `SELECT p.*, v.public_id AS voucher_public_id, v.status AS voucher_status FROM payouts p
       LEFT JOIN vouchers v ON v.id = p.voucher_id
       ${status ? "WHERE p.status = ?" : ""}
       ORDER BY p.created_at DESC LIMIT 300`,
    )
    .all(...(status ? [status] : [])) as Array<
    PayoutRow & { voucher_public_id: string | null; voucher_status: string | null }
  >;

  return rows.map((record) => ({
    id: record.id,
    voucher_public_id: record.voucher_public_id ?? null,
    amount: Number(record.amount),
    token: record.token,
    network: record.network,
    destination_address: record.destination_address,
    tx_hash: record.tx_hash,
    status: record.status,
    status_label: PAYOUT_STATUS_LABELS[record.status] ?? record.status,
    confirmations: Number(record.confirmations ?? 0),
    attempt_count: Number(record.attempt_count ?? 0),
    max_attempts: Number(record.max_attempts ?? 3),
    failure_reason: record.failure_reason,
    scenario: record.scenario,
    provider: record.provider,
    simulated: record.provider !== "tron-testnet-signer",
    created_at: record.created_at,
    confirmed_at: record.confirmed_at,
    voucher_status: record.voucher_status ?? null,
  }));
}

export async function getPayoutStats() {
  const rows = db.query(`SELECT status, amount FROM payouts`).all() as Array<{
    status: PayoutStatus;
    amount: number;
  }>;
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  const inFlight = rows.filter((r) =>
    ["PENDING", "BROADCAST", "CONFIRMING"].includes(r.status),
  ).length;
  return {
    total: rows.length,
    inFlight,
    failed: byStatus["FAILED"] ?? 0,
    manualReview: byStatus["MANUAL_REVIEW"] ?? 0,
    confirmed: byStatus["CONFIRMED"] ?? 0,
    confirmedValue: rows
      .filter((r) => r.status === "CONFIRMED")
      .reduce((sum, r) => sum + Number(r.amount), 0),
    byStatus,
  };
}

/**
 * Recovery worker — claims unfinished payouts (PENDING / BROADCAST / CONFIRMING
 * / retryable FAILED) and drives each one through the orchestrator.
 */
export async function runRecoverySweep(input: { worker: string; limit?: number }) {
  const rows = payoutClaimBatch(input.worker, input.limit ?? 10) as PayoutRow[];
  payoutLog("recovery.claimed", { worker: input.worker, count: rows.length });

  const outcomes: PayoutOutcome[] = [];
  for (const row of rows) {
    try {
      outcomes.push(await processPayout(toRecord(row)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "RECOVERY_ERROR";
      payoutLog("recovery.error", { payoutId: row.id, reason });
      const { payoutFail } = await import("@/lib/db/procedures/payouts");
      payoutFail(row.id, reason.slice(0, 500), true);
    }
  }
  return {
    worker: input.worker,
    claimed: rows.length,
    confirmed: outcomes.filter((o) => o.status === "CONFIRMED").length,
    stillOpen: outcomes.filter((o) => o.status === "CONFIRMING" || o.status === "FAILED").length,
    manualReview: outcomes.filter((o) => o.status === "MANUAL_REVIEW").length,
    outcomes,
  };
}

export type ReconciliationIssue = {
  payout_id: string;
  voucher_public_id: string | null;
  kind: string;
  detail: string;
  db_status: PayoutStatus;
  chain_status: string;
};

/**
 * Reconciliation — compares every non-terminal payout (plus confirmed ones) with
 * what the provider reports and reports inconsistencies instead of silently
 * mutating money state.
 */
export async function reconcilePayouts(): Promise<{
  checked: number;
  issues: ReconciliationIssue[];
}> {
  const rows = db
    .query(
      `SELECT p.*, v.public_id AS voucher_public_id, v.status AS voucher_status FROM payouts p
       LEFT JOIN vouchers v ON v.id = p.voucher_id
       ORDER BY p.created_at DESC LIMIT 200`,
    )
    .all() as Array<
    PayoutRow & { voucher_public_id: string | null; voucher_status: string | null }
  >;

  const provider = resolveRuntime().payoutProvider;
  const issues: ReconciliationIssue[] = [];

  for (const row of rows) {
    const publicId = row.voucher_public_id ?? null;
    const chain = row.tx_hash ? await provider.getTransactionStatus(row.tx_hash) : null;

    if (row.status === "CONFIRMED" && row.voucher_status && row.voucher_status !== "REDEEMED") {
      issues.push({
        payout_id: row.id,
        voucher_public_id: publicId,
        kind: "VOUCHER_NOT_REDEEMED",
        detail: `Payout confirmed but voucher is ${row.voucher_status}`,
        db_status: row.status,
        chain_status: chain?.status ?? "UNKNOWN",
      });
    }
    if (row.status !== "CONFIRMED" && row.voucher_status === "REDEEMED") {
      issues.push({
        payout_id: row.id,
        voucher_public_id: publicId,
        kind: "REDEEMED_WITHOUT_CONFIRMED_PAYOUT",
        detail: `Voucher redeemed while payout is ${row.status}`,
        db_status: row.status,
        chain_status: chain?.status ?? "UNKNOWN",
      });
    }
    if (row.tx_hash && chain === null && row.status !== "MANUAL_REVIEW") {
      issues.push({
        payout_id: row.id,
        voucher_public_id: publicId,
        kind: "TX_UNKNOWN_TO_PROVIDER",
        detail: "Provider has no record of the stored transaction hash",
        db_status: row.status,
        chain_status: "MISSING",
      });
    }
    if (chain && chain.status === "CONFIRMED" && row.status !== "CONFIRMED") {
      issues.push({
        payout_id: row.id,
        voucher_public_id: publicId,
        kind: "CHAIN_AHEAD_OF_DB",
        detail: "Provider reports confirmed but the payout is not finalized",
        db_status: row.status,
        chain_status: chain.status,
      });
    }
    if (chain && chain.status === "FAILED" && row.status === "CONFIRMED") {
      issues.push({
        payout_id: row.id,
        voucher_public_id: publicId,
        kind: "CHAIN_FAILED_DB_CONFIRMED",
        detail: "Provider reports failure but the payout was finalized",
        db_status: row.status,
        chain_status: chain.status,
      });
    }
  }

  payoutLog("reconciliation.completed", { checked: rows.length, issues: issues.length });
  return { checked: rows.length, issues };
}

export async function retryPayout(input: {
  payoutId: string;
  actorId: string | null;
  actorLabel: string;
}) {
  const result = payoutRetry(input);
  if (!result.ok) return { ok: false as const, message: result.error ?? "RETRY_FAILED" };

  const record = await supabasePayoutStore.load(input.payoutId);
  if (!record) return { ok: false as const, message: "NOT_FOUND" };
  const outcome = await processPayout(record);
  return { ok: true as const, outcome };
}

export async function flagManualReview(input: {
  payoutId: string;
  reason: string;
  actorId: string | null;
  actorLabel: string;
}) {
  const result = payoutManualReview(input);
  return result.ok
    ? { ok: true as const }
    : { ok: false as const, message: result.error ?? "FAILED" };
}

export async function releaseStuckVoucher(input: {
  payoutId: string;
  reason: string;
  actorId: string | null;
  actorLabel: string;
}) {
  // If a transfer was ever broadcast, ask the chain before letting the
  // voucher be redeemed again — an unknown/pending/confirmed hash means the
  // customer may already have (or still get) the funds.
  const record = await supabasePayoutStore.load(input.payoutId);
  if (!record) return { ok: false as const, message: "NOT_FOUND" };
  let chainFailureVerified = false;
  if (record.txHash) {
    const chain = await resolveRuntime().payoutProvider.getTransactionStatus(record.txHash);
    if (!chain || chain.status !== "FAILED") {
      payoutLog("release.refused", {
        payoutId: input.payoutId,
        txHash: record.txHash,
        chainStatus: chain?.status ?? "UNKNOWN",
      });
      return { ok: false as const, message: "TX_NOT_PROVEN_FAILED" };
    }
    chainFailureVerified = true;
  }

  const result = payoutReleaseVoucher({ ...input, chainFailureVerified });
  if (!result.ok) return { ok: false as const, message: result.error ?? "FAILED" };
  await writeAudit({
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    action: "PAYOUT_RELEASED",
    entity: "payout",
    entityId: input.payoutId,
    metadata: { reason: input.reason },
  });
  return { ok: true as const };
}
