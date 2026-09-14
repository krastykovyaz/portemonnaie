import { db, newId, nowIso, tx } from "../client";
import { payoutLog } from "@/lib/services/payout.server";

export type EnergyRentalStatus = "PENDING" | "ACTIVE" | "FAILED" | "EXPIRED" | "CANCELLED";

export type EnergyRentalRow = {
  id: string;
  provider: string;
  provider_order_id: string | null;
  treasury_address: string;
  requested_energy: number;
  delegated_energy: number | null;
  price_trx: number | null;
  price_usd: number | null;
  currency: string;
  duration: string | null;
  started_at: string | null;
  expires_at: string | null;
  status: EnergyRentalStatus;
  tx_hash: string | null;
  idempotency_key: string;
  payout_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export function getRentalByIdempotencyKey(key: string): EnergyRentalRow | null {
  return db
    .query(`SELECT * FROM energy_rentals WHERE idempotency_key = ?`)
    .get(key) as EnergyRentalRow | null;
}

export function getRentalById(id: string): EnergyRentalRow | null {
  return db.query(`SELECT * FROM energy_rentals WHERE id = ?`).get(id) as EnergyRentalRow | null;
}

/**
 * Idempotent create: a retry that reuses the same key gets the existing row
 * back (created: false) instead of inserting a second rental -- this, plus
 * the UNIQUE constraint on idempotency_key, is what makes "duplicate request
 * -> only one rental" hold even under a concurrent retry.
 */
export function createPendingRental(input: {
  provider: string;
  treasuryAddress: string;
  requestedEnergy: number;
  duration: string;
  idempotencyKey: string;
  payoutId?: string | null;
}): { rental: EnergyRentalRow; created: boolean } {
  return tx(() => {
    const existing = getRentalByIdempotencyKey(input.idempotencyKey);
    if (existing) return { rental: existing, created: false };
    const id = newId();
    const now = nowIso();
    db.query(
      `INSERT INTO energy_rentals
        (id, provider, treasury_address, requested_energy, duration, status, currency, idempotency_key, payout_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 'TRX', ?, ?, ?, ?)`,
    ).run(
      id,
      input.provider,
      input.treasuryAddress,
      input.requestedEnergy,
      input.duration,
      input.idempotencyKey,
      input.payoutId ?? null,
      now,
      now,
    );
    return { rental: getRentalById(id)!, created: true };
  });
}

export function markRentalActive(
  id: string,
  input: {
    providerOrderId: string;
    delegatedEnergy: number;
    priceTrx: number;
    priceUsd: number;
    startedAt: string;
    expiresAt: string;
    txHash: string | null;
  },
): void {
  const now = nowIso();
  db.query(
    `UPDATE energy_rentals SET status = 'ACTIVE', provider_order_id = ?, delegated_energy = ?, price_trx = ?,
      price_usd = ?, started_at = ?, expires_at = ?, tx_hash = ?, error_message = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.providerOrderId,
    input.delegatedEnergy,
    input.priceTrx,
    input.priceUsd,
    input.startedAt,
    input.expiresAt,
    input.txHash,
    now,
    id,
  );
}

export function markRentalFailed(id: string, errorMessage: string): void {
  const now = nowIso();
  db.query(`UPDATE energy_rentals SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ?`).run(
    errorMessage,
    now,
    id,
  );
}

/** Sweeps rentals whose expires_at has passed while still marked ACTIVE. Never touches a terminal (FAILED/CANCELLED) row. */
export function expireStaleRentals(nowIsoValue: string = nowIso()): number {
  const stale = db
    .query(`SELECT id, provider FROM energy_rentals WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at < ?`)
    .all(nowIsoValue) as Array<{ id: string; provider: string }>;
  if (stale.length === 0) return 0;

  const update = db.query(`UPDATE energy_rentals SET status = 'EXPIRED', updated_at = ? WHERE id = ?`);
  for (const row of stale) {
    update.run(nowIsoValue, row.id);
    payoutLog("ENERGY_RENTAL_EXPIRED", { provider: row.provider, rentalId: row.id });
  }
  return stale.length;
}

export function getLatestRental(): EnergyRentalRow | null {
  return db.query(`SELECT * FROM energy_rentals ORDER BY created_at DESC LIMIT 1`).get() as EnergyRentalRow | null;
}

export function getRentalStats(): {
  total: number;
  active: number;
  failed: number;
  expired: number;
} {
  const rows = db
    .query(`SELECT status, COUNT(*) AS n FROM energy_rentals GROUP BY status`)
    .all() as Array<{ status: EnergyRentalStatus; n: number }>;
  const byStatus: Partial<Record<EnergyRentalStatus, number>> = {};
  for (const row of rows) byStatus[row.status] = row.n;
  const total = Object.values(byStatus).reduce((sum: number, n) => sum + (n ?? 0), 0);
  return {
    total,
    active: byStatus.ACTIVE ?? 0,
    failed: byStatus.FAILED ?? 0,
    expired: byStatus.EXPIRED ?? 0,
  };
}
