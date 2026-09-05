import { db, newId, nowIso } from "../client";

export function treasurySnapshot(input: {
  label: string;
  asset: string;
  network: string;
  address: string;
  balance: number;
  pending?: number;
  health?: string;
}): void {
  const now = nowIso();
  db.query(
    `INSERT INTO treasury_accounts (id, label, asset, network, address, balance, pending_balance, health, last_synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset, network, address) DO UPDATE SET
       balance = excluded.balance, pending_balance = excluded.pending_balance,
       health = excluded.health, label = excluded.label, last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at`,
  ).run(
    newId(),
    input.label,
    input.asset,
    input.network,
    input.address,
    input.balance,
    input.pending ?? 0,
    input.health ?? "HEALTHY",
    now,
    now,
    now,
  );
}
