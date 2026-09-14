import { db, newId, nowIso, tx } from "../client";
import { writeAuditSync } from "@/lib/services/audit.server";
import { completeRedemption } from "./redemption";
import type { PayoutStatus } from "@/lib/payout/state-machine";
import { fetchActualResourceUsage } from "@/lib/energy/resource-lookup.server";
import { economicsConfig } from "@/lib/energy/economics-config";

export function payoutsEnabled(): boolean {
  const row = db.query(`SELECT payouts_enabled FROM payout_settings WHERE id = 1`).get() as {
    payouts_enabled: number;
  } | null;
  return row ? row.payouts_enabled === 1 : true;
}

export function setPayoutsEnabled(input: {
  enabled: boolean;
  reason?: string | null;
  actorId?: string | null;
  actorLabel: string;
}): { ok: true; payouts_enabled: boolean } {
  return tx(() => {
    const now = nowIso();
    db.query(
      `INSERT INTO payout_settings (id, payouts_enabled, paused_reason, updated_by, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payouts_enabled = excluded.payouts_enabled, paused_reason = excluded.paused_reason,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(input.enabled ? 1 : 0, input.reason ?? null, input.actorId ?? null, now, now);
    writeAuditSync({
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel,
      action: input.enabled ? "PAYOUTS_RESUMED" : "PAYOUTS_PAUSED",
      entity: "payout_settings",
      entityId: "global",
      metadata: { enabled: input.enabled, reason: input.reason ?? null },
    });
    return { ok: true as const, payouts_enabled: input.enabled };
  });
}

type PayoutRow = {
  id: string;
  redemption_id: string;
  voucher_id: string;
  transaction_id: string | null;
  user_id: string | null;
  fee_rate: number;
  status: PayoutStatus;
  attempt_count: number;
  max_attempts: number;
  amount: number;
  tx_hash: string | null;
  provider: string;
  energy_rental_id: string | null;
};

/** Recovery worker claim: picks up unfinished payouts and marks them locked by this worker. */
export function payoutClaimBatch(worker: string, limit: number): unknown[] {
  return tx(() => {
    const now = nowIso();
    const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const rows = db
      .query(
        `SELECT * FROM payouts
         WHERE status IN ('PENDING','BROADCAST','CONFIRMING','FAILED')
           AND next_attempt_at <= ?
           AND (locked_at IS NULL OR locked_at < ?)
           AND (status <> 'FAILED' OR attempt_count < max_attempts)
         ORDER BY created_at LIMIT ?`,
      )
      .all(now, twoMinAgo, limit) as Array<Record<string, unknown>>;
    const update = db.query(
      `UPDATE payouts SET locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?`,
    );
    for (const row of rows) update.run(worker, now, now, row["id"] as string);
    return rows;
  });
}

export function payoutMarkBroadcast(
  payoutId: string,
  providerTx: string,
  confirmations = 0,
): { ok: boolean; error?: string; status?: string } {
  return tx(() => {
    const p = db.query(`SELECT * FROM payouts WHERE id = ?`).get(payoutId) as PayoutRow | null;
    if (!p) return { ok: false, error: "NOT_FOUND" };
    if (!["PENDING", "BROADCAST", "FAILED"].includes(p.status)) {
      return { ok: false, error: "INVALID_TRANSITION", status: p.status };
    }
    const now = nowIso();
    db.query(
      `UPDATE payouts SET status = 'BROADCAST', provider_transaction_id = ?, tx_hash = ?, confirmations = ?,
        attempt_count = attempt_count + 1, broadcast_at = COALESCE(broadcast_at, ?), failure_reason = NULL,
        next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ).run(providerTx, providerTx, Math.max(confirmations, 0), now, now, now, p.id);
    if (p.transaction_id) {
      db.query(
        `UPDATE transactions SET status = 'BROADCAST', tx_hash = ?, confirmations = ?, updated_at = ? WHERE id = ?`,
      ).run(providerTx, Math.max(confirmations, 0), now, p.transaction_id);
    }
    writeAuditSync({
      actorId: p.user_id,
      actorLabel: p.user_id ?? "system",
      action: "PAYOUT_BROADCAST",
      entity: "payout",
      entityId: p.id,
      metadata: { tx_hash: providerTx, attempt: p.attempt_count + 1 },
    });
    return { ok: true, status: "BROADCAST" };
  });
}

export function payoutMarkConfirming(
  payoutId: string,
  confirmations: number,
): { ok: boolean; error?: string; status?: string } {
  return tx(() => {
    const p = db.query(`SELECT * FROM payouts WHERE id = ?`).get(payoutId) as PayoutRow | null;
    if (!p) return { ok: false, error: "NOT_FOUND" };
    if (!["BROADCAST", "CONFIRMING"].includes(p.status))
      return { ok: false, error: "INVALID_TRANSITION", status: p.status };
    const now = nowIso();
    const next = new Date(Date.now() + 5000).toISOString();
    db.query(
      `UPDATE payouts SET status = 'CONFIRMING', confirmations = ?, confirming_at = COALESCE(confirming_at, ?), next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ).run(confirmations, now, next, now, p.id);
    if (p.transaction_id) {
      db.query(
        `UPDATE transactions SET status = 'CONFIRMING', confirmations = ?, updated_at = ? WHERE id = ?`,
      ).run(confirmations, now, p.transaction_id);
    }
    return { ok: true, status: "CONFIRMING" };
  });
}

export async function payoutConfirm(
  payoutId: string,
  confirmations = 20,
): Promise<{
  ok: boolean;
  error?: string;
  status?: string;
  replayed?: boolean;
  tx_hash?: string | null;
  amount?: number;
  fee?: number;
}> {
  const preCheck = db.query(`SELECT * FROM payouts WHERE id = ?`).get(payoutId) as PayoutRow | null;
  if (!preCheck) return { ok: false, error: "NOT_FOUND" };
  if (preCheck.status === "CONFIRMED") {
    return { ok: true, status: "CONFIRMED", replayed: true, tx_hash: preCheck.tx_hash, amount: preCheck.amount };
  }
  if (!["BROADCAST", "CONFIRMING"].includes(preCheck.status)) {
    return { ok: false, error: "INVALID_TRANSITION", status: preCheck.status };
  }

  // Real, receipt-sourced resource usage — fetched BEFORE the synchronous
  // sql.js transaction below (network I/O can't happen inside it). Only for
  // real (non-mock) payouts with a broadcast tx hash; a mock/simulated
  // payout has no real receipt, so its actual_* columns stay null rather
  // than being guessed from the pre-broadcast estimate.
  let actual: Awaited<ReturnType<typeof fetchActualResourceUsage>> = null;
  if (preCheck.tx_hash && preCheck.provider !== "mock-tron-testnet") {
    const apiUrl = process.env["TRON_API_URL"] ?? "https://nile.trongrid.io";
    actual = await fetchActualResourceUsage(preCheck.tx_hash, apiUrl);
  }
  const config = economicsConfig();
  const trxBurned = actual ? (actual.netFeeSun + actual.energyFeeSun) / 1_000_000 : null;
  const trxCostUsd = trxBurned !== null ? trxBurned * config.trxUsdPrice : null;

  return tx(() => {
    const p = db.query(`SELECT * FROM payouts WHERE id = ?`).get(payoutId) as PayoutRow | null;
    if (!p) return { ok: false, error: "NOT_FOUND" };
    if (p.status === "CONFIRMED") {
      return {
        ok: true,
        status: "CONFIRMED",
        replayed: true,
        tx_hash: p.tx_hash,
        amount: p.amount,
      };
    }
    if (!["BROADCAST", "CONFIRMING"].includes(p.status))
      return { ok: false, error: "INVALID_TRANSITION", status: p.status };

    // Fold in what we paid a rental provider (if this payout used one) on
    // top of the actual on-chain burn -- for BURN/STAKED payouts (no
    // energy_rental_id) this leaves provider_cost/total_network_cost exactly
    // as they were before rental support existed.
    let rentalPriceUsd: number | null = null;
    if (p.energy_rental_id) {
      const rental = db
        .query(`SELECT price_usd FROM energy_rentals WHERE id = ?`)
        .get(p.energy_rental_id) as { price_usd: number | null } | null;
      rentalPriceUsd = rental?.price_usd ?? null;
    }
    const providerCost = rentalPriceUsd ?? trxCostUsd;
    const totalNetworkCost =
      trxCostUsd === null && rentalPriceUsd === null ? null : (trxCostUsd ?? 0) + (rentalPriceUsd ?? 0);

    const now = nowIso();
    db.query(
      `UPDATE payouts SET status = 'CONFIRMED', confirmations = ?, confirmed_at = ?, failure_reason = NULL,
        locked_by = NULL, locked_at = NULL, updated_at = ?,
        actual_energy = ?, actual_bandwidth = ?, trx_burned = ?, trx_cost_usd = ?,
        provider_cost = ?, total_network_cost = ?
       WHERE id = ?`,
    ).run(
      confirmations,
      now,
      now,
      actual?.energyUsed ?? null,
      actual?.bandwidthUsed ?? null,
      trxBurned,
      trxCostUsd,
      providerCost,
      totalNetworkCost,
      p.id,
    );

    const done = completeRedemption(p.redemption_id, p.tx_hash ?? "", confirmations, p.fee_rate);
    const fee = Math.round(p.amount * p.fee_rate * 100) / 100;
    db.query(`UPDATE vouchers SET payout_amount = ?, updated_at = ? WHERE id = ?`).run(
      p.amount - fee,
      now,
      p.voucher_id,
    );

    writeAuditSync({
      actorId: p.user_id,
      actorLabel: p.user_id ?? "system",
      action: "PAYOUT_CONFIRMED",
      entity: "payout",
      entityId: p.id,
      metadata: {
        tx_hash: p.tx_hash,
        confirmations,
        actual_energy: actual?.energyUsed ?? null,
        actual_bandwidth: actual?.bandwidthUsed ?? null,
        trx_burned: trxBurned,
        rental_price_usd: rentalPriceUsd,
        total_network_cost_usd: totalNetworkCost,
        ledger: done as unknown as Record<string, never>,
      },
    });

    return { ok: true, status: "CONFIRMED", tx_hash: p.tx_hash, amount: p.amount, fee };
  });
}

export function payoutFail(
  payoutId: string,
  reason: string,
  forceManual = false,
): { ok: boolean; error?: string; status?: PayoutStatus } {
  return tx(() => {
    const p = db.query(`SELECT * FROM payouts WHERE id = ?`).get(payoutId) as PayoutRow | null;
    if (!p) return { ok: false, error: "NOT_FOUND" };
    if (p.status === "CONFIRMED") return { ok: false, error: "ALREADY_CONFIRMED" };

    const attempts = Math.max(p.attempt_count, 1);
    const status: PayoutStatus =
      forceManual || attempts >= p.max_attempts ? "MANUAL_REVIEW" : "FAILED";
    const now = nowIso();
    const next = new Date(Date.now() + 15000).toISOString();
    db.query(
      `UPDATE payouts SET status = ?, failure_reason = ?, attempt_count = ?, failed_at = ?, locked_by = NULL, locked_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ).run(status, reason, attempts, now, next, now, p.id);
    if (p.transaction_id) {
      db.query(`UPDATE transactions SET status = 'FAILED', updated_at = ? WHERE id = ?`).run(
        now,
        p.transaction_id,
      );
    }
    writeAuditSync({
      actorId: p.user_id,
      actorLabel: p.user_id ?? "system",
      action: status === "MANUAL_REVIEW" ? "PAYOUT_MANUAL_REVIEW" : "PAYOUT_FAILED",
      entity: "payout",
      entityId: p.id,
      metadata: { reason, attempt: attempts, status },
    });
    return { ok: true, status };
  });
}

export function payoutRetry(input: {
  payoutId: string;
  actorId?: string | null;
  actorLabel: string;
}): { ok: boolean; error?: string; status?: string } {
  return tx(() => {
    const p = db
      .query(`SELECT * FROM payouts WHERE id = ?`)
      .get(input.payoutId) as PayoutRow | null;
    if (!p) return { ok: false, error: "NOT_FOUND" };
    if (p.status === "CONFIRMED") return { ok: false, error: "ALREADY_CONFIRMED" };
    if (!["FAILED", "MANUAL_REVIEW"].includes(p.status))
      return { ok: false, error: "NOT_RETRYABLE", status: p.status };
    if (!payoutsEnabled()) return { ok: false, error: "PAYOUTS_PAUSED" };

    const now = nowIso();
    db.query(
      `UPDATE payouts SET status = 'PENDING', failure_reason = NULL, max_attempts = MAX(max_attempts, attempt_count + 1),
        next_attempt_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, now, p.id);
    if (p.transaction_id) {
      db.query(`UPDATE transactions SET status = 'PENDING', updated_at = ? WHERE id = ?`).run(
        now,
        p.transaction_id,
      );
    }
    writeAuditSync({
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel,
      action: "PAYOUT_RETRY_QUEUED",
      entity: "payout",
      entityId: p.id,
      metadata: { previous_status: p.status, attempt_count: p.attempt_count },
    });
    return { ok: true, status: "PENDING" };
  });
}

export function payoutManualReview(input: {
  payoutId: string;
  reason: string;
  actorId?: string | null;
  actorLabel: string;
}): { ok: boolean; error?: string; status?: string } {
  return tx(() => {
    const p = db
      .query(`SELECT * FROM payouts WHERE id = ?`)
      .get(input.payoutId) as PayoutRow | null;
    if (!p) return { ok: false, error: "NOT_FOUND" };
    if (p.status === "CONFIRMED") return { ok: false, error: "ALREADY_CONFIRMED" };
    const now = nowIso();
    db.query(
      `UPDATE payouts SET status = 'MANUAL_REVIEW', failure_reason = COALESCE(?, failure_reason), locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(input.reason, now, p.id);
    writeAuditSync({
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel,
      action: "PAYOUT_MANUAL_REVIEW",
      entity: "payout",
      entityId: p.id,
      metadata: { reason: input.reason, previous_status: p.status },
    });
    return { ok: true, status: "MANUAL_REVIEW" };
  });
}

export function payoutReleaseVoucher(input: {
  payoutId: string;
  reason: string;
  actorId?: string | null;
  actorLabel: string;
}): { ok: boolean; error?: string; status?: string } {
  return tx(() => {
    const p = db
      .query(`SELECT * FROM payouts WHERE id = ?`)
      .get(input.payoutId) as PayoutRow | null;
    if (!p) return { ok: false, error: "NOT_FOUND" };
    if (p.status === "CONFIRMED") return { ok: false, error: "ALREADY_CONFIRMED" };
    const now = nowIso();
    db.query(
      `UPDATE payouts SET status = 'MANUAL_REVIEW', failure_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(input.reason || "RELEASED", now, p.id);
    db.query(
      `UPDATE voucher_redemptions SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ?`,
    ).run(input.reason || "RELEASED", now, p.redemption_id);
    if (p.transaction_id) {
      db.query(`UPDATE transactions SET status = 'FAILED', updated_at = ? WHERE id = ?`).run(
        now,
        p.transaction_id,
      );
    }
    db.query(
      `UPDATE vouchers SET status = 'SOLD', updated_at = ? WHERE id = ? AND status = 'REDEEMING'`,
    ).run(now, p.voucher_id);
    writeAuditSync({
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel,
      action: "PAYOUT_VOUCHER_RELEASED",
      entity: "payout",
      entityId: p.id,
      metadata: { reason: input.reason },
    });
    return { ok: true, status: "MANUAL_REVIEW" };
  });
}

export function createPayoutForRedemption(input: {
  redemptionId: string;
  voucherId: string;
  transactionId: string | null;
  userId: string | null;
  amount: number;
  network: string;
  token: string;
  destination: string;
  idempotencyKey: string;
  /** Defaults to the schema's 'mock-tron-testnet' — pass the real signer's id for a real payout. */
  provider?: string;
  status?: PayoutStatus;
  confirmations?: number;
  txHash?: string | null;
  createdAt?: string;
  broadcastAt?: string | null;
  confirmedAt?: string | null;
  /** Cost estimate computed by the EnergyManager before broadcast — see src/lib/energy/. */
  recipientKind?: "fresh" | "existing" | null;
  estimatedEnergy?: number | null;
  estimatedBandwidth?: number | null;
  resourceSource?: string | null;
  /** Set when planPayoutResources() actually purchased a rental for this payout — see src/lib/energy/rental/. */
  energyRentalId?: string | null;
}): string {
  const id = newId();
  const now = nowIso();
  db.query(
    `INSERT INTO payouts (id, redemption_id, voucher_id, transaction_id, user_id, idempotency_key, provider, network, token,
      amount, destination_address, tx_hash, status, confirmations, attempt_count, next_attempt_at, created_at,
      broadcast_at, confirmed_at, updated_at, recipient_kind, estimated_energy, estimated_bandwidth, resource_source, energy_rental_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.redemptionId,
    input.voucherId,
    input.transactionId,
    input.userId,
    input.idempotencyKey,
    input.provider ?? "mock-tron-testnet",
    input.network,
    input.token,
    input.amount,
    input.destination,
    input.txHash ?? null,
    input.status ?? "PENDING",
    input.confirmations ?? 0,
    input.createdAt ?? now,
    input.createdAt ?? now,
    input.broadcastAt ?? null,
    input.confirmedAt ?? null,
    now,
    input.recipientKind ?? null,
    input.estimatedEnergy ?? null,
    input.estimatedBandwidth ?? null,
    input.resourceSource ?? null,
    input.energyRentalId ?? null,
  );
  return id;
}
