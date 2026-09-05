import { db, newId, nowIso } from "@/lib/db/client";
import { manualReviewResolve } from "@/lib/db/procedures/reviews";
import { treasurySnapshot } from "@/lib/db/procedures/treasury";
import { resolveRuntime } from "../providers/registry.server";
import { AMOUNT_TOLERANCE } from "../orders/state-machine";
import { writeAudit } from "./audit.server";

export type ManualReviewRow = {
  id: string;
  kind: string;
  severity: string;
  status: "OPEN" | "RESOLVED" | "REJECTED";
  subject_type: string;
  subject_id: string;
  detail: string;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
};

export async function listManualReviews(status = "OPEN"): Promise<ManualReviewRow[]> {
  const rows =
    status === "ALL"
      ? db
          .query(
            `SELECT id, kind, severity, status, subject_type, subject_id, detail, resolution, created_at, resolved_at
             FROM manual_reviews ORDER BY created_at DESC LIMIT 200`,
          )
          .all()
      : db
          .query(
            `SELECT id, kind, severity, status, subject_type, subject_id, detail, resolution, created_at, resolved_at
             FROM manual_reviews WHERE status = ? ORDER BY created_at DESC LIMIT 200`,
          )
          .all(status);
  return rows as unknown as ManualReviewRow[];
}

export async function resolveManualReview(input: {
  reviewId: string;
  resolution: string;
  status: "RESOLVED" | "REJECTED";
  actorId: string;
  actorLabel: string;
}) {
  const result = manualReviewResolve(input);
  if (!result.ok) return { ok: false as const, message: result.error ?? "RESOLVE_FAILED" };
  return { ok: true as const };
}

export async function listTreasury() {
  const rows = db.query(`SELECT * FROM treasury_accounts ORDER BY label`).all() as Array<{
    id: string;
    label: string;
    asset: string;
    network: string;
    address: string;
    balance: number;
    pending_balance: number;
    health: string;
    last_synced_at: string | null;
  }>;
  return rows.map((row) => ({
    ...row,
    balance: Number(row.balance),
    pending_balance: Number(row.pending_balance),
  }));
}

/**
 * Treasury sync — reads balances through the active gateway abstraction so the
 * same code path works for the mock, testnet and mainnet providers.
 */
export async function syncTreasury() {
  const runtime = resolveRuntime();
  const accounts = await listTreasury();
  let synced = 0;
  for (const account of accounts) {
    const balance = await runtime.gateway.getBalance(account.address).catch(() => null);
    if (balance === null) continue;
    treasurySnapshot({
      label: account.label,
      asset: account.asset,
      network: account.network,
      address: account.address,
      balance,
      pending: account.pending_balance,
      health: balance <= 0 ? "EMPTY" : "HEALTHY",
    });
    synced += 1;
  }
  return { accounts: accounts.length, synced, gateway: runtime.gateway.id };
}

export type ReconRecord = {
  id: string;
  scope: string;
  status: string;
  subject_type: string;
  subject_id: string | null;
  internal_amount: number | null;
  chain_amount: number | null;
  detail: string;
  created_at: string;
};

/**
 * Order-level reconciliation: compares what the database believes was received
 * for every open/settled payment against what the chain provider reports, and
 * records the outcome instead of silently mutating money state.
 */
export async function reconcileOrders() {
  const runtime = resolveRuntime();
  const runId = crypto.randomUUID();

  const rows = db
    .query(
      `SELECT id, order_id, address, required_amount, detected_amount, status, tx_hash
       FROM payment_requests ORDER BY created_at DESC LIMIT 200`,
    )
    .all() as Array<{
    id: string;
    order_id: string;
    address: string;
    required_amount: number;
    detected_amount: number;
    status: string;
    tx_hash: string | null;
  }>;

  const records: {
    id: string;
    run_id: string;
    scope: string;
    status: string;
    subject_type: string;
    subject_id: string;
    internal_amount: number;
    chain_amount: number;
    detail: string;
  }[] = [];

  for (const row of rows) {
    const transfers = await runtime.gateway.getIncomingTransfers(row.address).catch(() => []);
    const chainAmount = transfers.reduce((sum, t) => sum + Number(t.amount), 0);
    const internal = Number(row.detected_amount);
    let status = "MATCHED";
    let detail = "Internal and chain amounts agree";

    if (transfers.length === 0 && internal > 0) {
      status = "MISSING_ON_CHAIN";
      detail = "Payment recorded internally but no transfer visible on chain";
    } else if (transfers.length > 0 && internal === 0) {
      status = "MISSING_INTERNAL";
      detail = "Chain transfer visible but nothing recorded internally";
    } else if (Math.abs(chainAmount - internal) > AMOUNT_TOLERANCE) {
      status = "AMOUNT_MISMATCH";
      detail = `Internal ${internal} vs chain ${chainAmount}`;
    }

    records.push({
      id: newId(),
      run_id: runId,
      scope: "ORDER_PAYMENTS",
      status,
      subject_type: "payment_request",
      subject_id: row.id,
      internal_amount: internal,
      chain_amount: chainAmount,
      detail,
    });
  }

  if (records.length > 0) {
    const now = nowIso();
    const insert = db.query(
      `INSERT INTO reconciliation_records (id, run_id, scope, status, subject_type, subject_id, internal_amount, chain_amount, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of records) {
      insert.run(
        r.id,
        r.run_id,
        r.scope,
        r.status,
        r.subject_type,
        r.subject_id,
        r.internal_amount,
        r.chain_amount,
        r.detail,
        now,
      );
    }
  }

  const mismatches = records.filter((r) => r.status !== "MATCHED");
  const { manualReviewOpen } = await import("@/lib/db/procedures/reviews");
  for (const mismatch of mismatches) {
    manualReviewOpen({
      kind: `RECON_${mismatch.status}`,
      subjectType: mismatch.subject_type,
      subjectId: mismatch.subject_id,
      detail: mismatch.detail,
      severity: "HIGH",
      dedupeKey: `recon:${mismatch.subject_id}:${mismatch.status}`,
    });
  }

  return { runId, checked: records.length, mismatches: mismatches.length };
}

export async function listReconciliation(limit = 100): Promise<ReconRecord[]> {
  return db
    .query(
      `SELECT id, scope, status, subject_type, subject_id, internal_amount, chain_amount, detail, created_at
       FROM reconciliation_records ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as ReconRecord[];
}

export async function auditOpsAction(input: {
  actorId: string;
  actorLabel: string;
  action: string;
  entityId?: string;
}) {
  await writeAudit({
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    action: input.action,
    entity: "ops",
    entityId: input.entityId ?? null,
  });
}
