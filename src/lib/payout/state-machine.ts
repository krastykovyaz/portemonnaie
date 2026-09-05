/**
 * Payout state machine — pure, dependency-free, shared by server code and tests.
 *
 * Voucher state and payout state are deliberately SEPARATE concerns:
 *   voucher:  SOLD -> REDEEMING -> REDEEMED
 *   payout:   PENDING -> BROADCAST -> CONFIRMING -> CONFIRMED
 *                                  \-> FAILED -> (retry) -> PENDING
 *                                  \-> MANUAL_REVIEW (terminal until an admin acts)
 *
 * A voucher may ONLY become REDEEMED once its payout reaches CONFIRMED.
 */

export type PayoutStatus =
  | "NOT_STARTED"
  | "PENDING"
  | "BROADCAST"
  | "CONFIRMING"
  | "CONFIRMED"
  | "FAILED"
  | "MANUAL_REVIEW";

export const REQUIRED_CONFIRMATIONS = 3;
export const DEFAULT_MAX_ATTEMPTS = 3;

const TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  NOT_STARTED: ["PENDING", "FAILED", "MANUAL_REVIEW"],
  PENDING: ["BROADCAST", "FAILED", "MANUAL_REVIEW"],
  BROADCAST: ["CONFIRMING", "CONFIRMED", "FAILED", "MANUAL_REVIEW"],
  CONFIRMING: ["CONFIRMED", "CONFIRMING", "FAILED", "MANUAL_REVIEW"],
  CONFIRMED: [],
  FAILED: ["PENDING", "BROADCAST", "MANUAL_REVIEW"],
  MANUAL_REVIEW: ["PENDING"],
};

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal payout transition ${from} -> ${to}`);
  }
}

export function isTerminal(status: PayoutStatus): boolean {
  return status === "CONFIRMED" || status === "MANUAL_REVIEW";
}

/** A payout that the recovery worker should pick up again. */
export function isRecoverable(status: PayoutStatus): boolean {
  return (
    status === "NOT_STARTED" ||
    status === "PENDING" ||
    status === "BROADCAST" ||
    status === "CONFIRMING" ||
    status === "FAILED"
  );
}

export function canFinalizeVoucher(status: PayoutStatus, confirmations: number): boolean {
  return status === "CONFIRMED" && confirmations >= REQUIRED_CONFIRMATIONS;
}

export function shouldEscalateToManualReview(
  attemptCount: number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): boolean {
  return attemptCount >= maxAttempts;
}

export const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  NOT_STARTED: "Not started",
  PENDING: "Pending",
  BROADCAST: "Broadcast",
  CONFIRMING: "Confirming",
  CONFIRMED: "Confirmed",
  FAILED: "Failed",
  MANUAL_REVIEW: "Manual review",
};
