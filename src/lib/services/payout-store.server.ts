import { db } from "@/lib/db/client";
import {
  payoutMarkBroadcast,
  payoutMarkConfirming,
  payoutConfirm,
  payoutFail,
} from "@/lib/db/procedures/payouts";
import type { PayoutRecord, PayoutStore } from "../payout/orchestrator";
import type { PayoutStatus } from "../payout/state-machine";

export type PayoutRow = {
  id: string;
  redemption_id: string;
  voucher_id: string;
  transaction_id: string | null;
  user_id: string | null;
  idempotency_key: string;
  provider: string;
  network: string;
  token: string;
  amount: number;
  fee_rate: number;
  destination_address: string;
  provider_transaction_id: string | null;
  tx_hash: string | null;
  status: PayoutStatus;
  confirmations: number;
  attempt_count: number;
  max_attempts: number;
  scenario: string;
  failure_reason: string | null;
  next_attempt_at: string;
  created_at: string;
  broadcast_at: string | null;
  confirmed_at: string | null;
  failed_at: string | null;
  updated_at: string;
};

export function toRecord(row: PayoutRow): PayoutRecord {
  return {
    id: row.id,
    redemptionId: row.redemption_id,
    voucherId: row.voucher_id,
    idempotencyKey: row.idempotency_key,
    amount: Number(row.amount),
    token: row.token,
    network: row.network,
    destination: row.destination_address,
    status: row.status,
    txHash: row.tx_hash,
    confirmations: Number(row.confirmations ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    failureReason: row.failure_reason,
  };
}

/** SQLite-backed PayoutStore. All writes go through guarded procedures/payouts.ts functions. */
export const supabasePayoutStore: PayoutStore = {
  async load(payoutId) {
    const row = db.query(`SELECT * FROM payouts WHERE id = ?`).get(payoutId) as PayoutRow | null;
    return row ? toRecord(row) : null;
  },

  async markBroadcast(payoutId, txHash, confirmations) {
    const result = payoutMarkBroadcast(payoutId, txHash, confirmations);
    if (!result.ok) throw new Error(result.error ?? "MARK_BROADCAST_FAILED");
  },

  async markConfirming(payoutId, confirmations) {
    const result = payoutMarkConfirming(payoutId, confirmations);
    if (!result.ok) throw new Error(result.error ?? "MARK_CONFIRMING_FAILED");
  },

  async confirm(payoutId, confirmations) {
    const result = await payoutConfirm(payoutId, confirmations);
    if (!result.ok) return { ok: false, error: result.error ?? "CONFIRM_FAILED" };
    return { ok: true };
  },

  async fail(payoutId, reason, forceManual) {
    const result = payoutFail(payoutId, reason.slice(0, 500), forceManual);
    return { ok: result.ok !== false, status: result.status ?? "MANUAL_REVIEW" };
  },
};
