import type { PayoutRecord, PayoutStore } from "./orchestrator";
import { assertTransition, type PayoutStatus } from "./state-machine";

/**
 * In-memory PayoutStore used by unit tests. It mirrors the guarantees of the
 * database functions: legal transitions only, one payout per idempotency key,
 * and the voucher is only marked REDEEMED when the payout is CONFIRMED.
 */
export class MemoryPayoutStore implements PayoutStore {
  payouts = new Map<string, PayoutRecord>();
  vouchers = new Map<string, { status: string }>();
  ledger: { payoutId: string; amount: number }[] = [];
  private byKey = new Map<string, string>();
  private seq = 0;

  seedVoucher(voucherId: string, status = "SOLD") {
    this.vouchers.set(voucherId, { status });
  }

  /** Mirrors start_redemption_v2: idempotent on the key. */
  start(input: {
    voucherId: string;
    idempotencyKey: string;
    amount: number;
    destination: string;
    maxAttempts?: number;
  }): { payout: PayoutRecord; replayed: boolean } | { error: string } {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) {
      return { payout: this.payouts.get(existingId)!, replayed: true };
    }
    const voucher = this.vouchers.get(input.voucherId);
    if (!voucher) return { error: "NOT_FOUND" };
    if (voucher.status !== "SOLD") return { error: "INVALID_STATUS" };

    this.seq += 1;
    const payout: PayoutRecord = {
      id: `payout-${this.seq}`,
      redemptionId: `redemption-${this.seq}`,
      voucherId: input.voucherId,
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      token: "USDT",
      network: "TRON_TESTNET",
      destination: input.destination,
      status: "PENDING",
      txHash: null,
      confirmations: 0,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 3,
      failureReason: null,
    };
    this.payouts.set(payout.id, payout);
    this.byKey.set(input.idempotencyKey, payout.id);
    voucher.status = "REDEEMING";
    return { payout, replayed: false };
  }

  async load(payoutId: string): Promise<PayoutRecord | null> {
    const found = this.payouts.get(payoutId);
    return found ? { ...found } : null;
  }

  private mutate(payoutId: string, to: PayoutStatus, patch: Partial<PayoutRecord>) {
    const payout = this.payouts.get(payoutId);
    if (!payout) throw new Error("NOT_FOUND");
    assertTransition(payout.status, to);
    Object.assign(payout, patch, { status: to });
    return payout;
  }

  async markBroadcast(payoutId: string, txHash: string, confirmations: number): Promise<void> {
    const current = this.payouts.get(payoutId);
    if (!current) throw new Error("NOT_FOUND");
    this.mutate(payoutId, "BROADCAST", {
      txHash,
      confirmations,
      attemptCount: current.attemptCount + 1,
      failureReason: null,
    });
  }

  async markConfirming(payoutId: string, confirmations: number): Promise<void> {
    this.mutate(payoutId, "CONFIRMING", { confirmations });
  }

  async confirm(payoutId: string, confirmations: number): Promise<{ ok: boolean; error?: string }> {
    const payout = this.payouts.get(payoutId);
    if (!payout) return { ok: false, error: "NOT_FOUND" };
    if (payout.status === "CONFIRMED") return { ok: true };
    this.mutate(payoutId, "CONFIRMED", { confirmations, failureReason: null });
    const voucher = this.vouchers.get(payout.voucherId);
    if (voucher) voucher.status = "REDEEMED";
    // Ledger is append-only and posted exactly once per payout.
    if (!this.ledger.some((entry) => entry.payoutId === payoutId)) {
      this.ledger.push({ payoutId, amount: payout.amount });
    }
    return { ok: true };
  }

  async fail(
    payoutId: string,
    reason: string,
    forceManual: boolean,
  ): Promise<{ ok: boolean; status: PayoutStatus }> {
    const payout = this.payouts.get(payoutId);
    if (!payout) return { ok: false, status: "MANUAL_REVIEW" };
    if (payout.status === "CONFIRMED") return { ok: false, status: "CONFIRMED" };
    const attempts = Math.max(payout.attemptCount, 1);
    const status: PayoutStatus =
      forceManual || attempts >= payout.maxAttempts ? "MANUAL_REVIEW" : "FAILED";
    this.mutate(payoutId, status, { failureReason: reason, attemptCount: attempts });
    return { ok: true, status };
  }

  /** Mirrors payout_retry: reuses the same payout row and idempotency key. */
  retry(payoutId: string): { ok: boolean; error?: string } {
    const payout = this.payouts.get(payoutId);
    if (!payout) return { ok: false, error: "NOT_FOUND" };
    if (payout.status === "CONFIRMED") return { ok: false, error: "ALREADY_CONFIRMED" };
    if (payout.status !== "FAILED" && payout.status !== "MANUAL_REVIEW") {
      return { ok: false, error: "NOT_RETRYABLE" };
    }
    this.mutate(payoutId, "PENDING", {
      failureReason: null,
      maxAttempts: Math.max(payout.maxAttempts, payout.attemptCount + 1),
    });
    return { ok: true };
  }

  recoverable(): PayoutRecord[] {
    return [...this.payouts.values()]
      .filter(
        (p) =>
          p.status === "PENDING" ||
          p.status === "BROADCAST" ||
          p.status === "CONFIRMING" ||
          (p.status === "FAILED" && p.attemptCount < p.maxAttempts),
      )
      .map((p) => ({ ...p }));
  }
}
