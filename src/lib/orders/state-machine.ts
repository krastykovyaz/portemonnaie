/**
 * Order + payment state machines — pure mirrors of the database rules so tests
 * and UI can reason about the lifecycle without a database round trip.
 *
 *  order:    CREATED -> RESERVED -> PAYMENT_PENDING -> PAYMENT_DETECTED
 *                    -> PAYMENT_CONFIRMED -> VOUCHER_DELIVERED -> COMPLETED
 *  payment:  WAITING -> DETECTED -> CONFIRMING -> CONFIRMED
 *                                \-> UNDERPAID / OVERPAID / EXPIRED / FAILED
 */

export type OrderStatus =
  | "CREATED"
  | "RESERVED"
  | "PAYMENT_PENDING"
  | "PAYMENT_DETECTED"
  | "PAYMENT_CONFIRMED"
  | "VOUCHER_DELIVERED"
  | "COMPLETED"
  | "PAYMENT_EXPIRED"
  | "PAYMENT_UNDERPAID"
  | "PAYMENT_OVERPAID"
  | "PAYMENT_FAILED"
  | "FULFILLMENT_FAILED"
  | "CANCELLED"
  | "MANUAL_REVIEW";

export type PaymentStatus =
  | "WAITING"
  | "DETECTED"
  | "CONFIRMING"
  | "CONFIRMED"
  | "UNDERPAID"
  | "OVERPAID"
  | "EXPIRED"
  | "FAILED"
  | "MANUAL_REVIEW";

export type DeliveryStatus = "PENDING" | "SENDING" | "DELIVERED" | "FAILED" | "MANUAL_REVIEW";

const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ["RESERVED", "PAYMENT_PENDING", "PAYMENT_EXPIRED", "PAYMENT_FAILED"],
  RESERVED: ["PAYMENT_PENDING", "PAYMENT_EXPIRED", "PAYMENT_FAILED"],
  PAYMENT_PENDING: [
    "PAYMENT_DETECTED",
    "PAYMENT_CONFIRMED",
    "PAYMENT_UNDERPAID",
    "PAYMENT_OVERPAID",
    "PAYMENT_EXPIRED",
    "PAYMENT_FAILED",
  ],
  PAYMENT_DETECTED: [
    "PAYMENT_DETECTED",
    "PAYMENT_CONFIRMED",
    "PAYMENT_UNDERPAID",
    "PAYMENT_OVERPAID",
    "PAYMENT_EXPIRED",
    "PAYMENT_FAILED",
  ],
  PAYMENT_UNDERPAID: ["PAYMENT_CONFIRMED", "PAYMENT_OVERPAID", "PAYMENT_EXPIRED", "PAYMENT_FAILED"],
  PAYMENT_OVERPAID: ["PAYMENT_CONFIRMED", "VOUCHER_DELIVERED", "FULFILLMENT_FAILED"],
  PAYMENT_CONFIRMED: ["VOUCHER_DELIVERED", "FULFILLMENT_FAILED"],
  VOUCHER_DELIVERED: ["COMPLETED", "FULFILLMENT_FAILED"],
  FULFILLMENT_FAILED: ["PAYMENT_CONFIRMED", "VOUCHER_DELIVERED"],
  MANUAL_REVIEW: [
    "PAYMENT_CONFIRMED",
    "PAYMENT_OVERPAID",
    "PAYMENT_UNDERPAID",
    "VOUCHER_DELIVERED",
    "COMPLETED",
    "PAYMENT_EXPIRED",
  ],
  COMPLETED: [],
  PAYMENT_EXPIRED: [],
  PAYMENT_FAILED: [],
  CANCELLED: [],
};

export function canOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  if ((to === "MANUAL_REVIEW" || to === "CANCELLED") && from !== "COMPLETED") return true;
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canOrderTransition(from, to)) {
    throw new Error(`Illegal order transition ${from} -> ${to}`);
  }
}

export function isOrderTerminal(status: OrderStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "PAYMENT_EXPIRED" ||
    status === "PAYMENT_FAILED" ||
    status === "CANCELLED"
  );
}

export function isOrderOpen(status: OrderStatus): boolean {
  return !isOrderTerminal(status);
}

export const AMOUNT_TOLERANCE = 0.005;

export type PaymentClassification = {
  status: PaymentStatus;
  orderStatus: OrderStatus;
  difference: number;
};

/**
 * Single source of truth for under/over payment classification. Mirrors
 * public.payment_observe so tests can pin the behaviour exactly.
 */
export function classifyPayment(input: {
  required: number;
  detected: number;
  confirmations: number;
  requiredConfirmations: number;
}): PaymentClassification {
  const difference = Math.round((input.detected - input.required) * 100) / 100;
  if (input.confirmations < input.requiredConfirmations) {
    return {
      status: input.confirmations === 0 ? "DETECTED" : "CONFIRMING",
      orderStatus: "PAYMENT_DETECTED",
      difference,
    };
  }
  if (difference < -AMOUNT_TOLERANCE) {
    return { status: "UNDERPAID", orderStatus: "PAYMENT_UNDERPAID", difference };
  }
  if (difference > AMOUNT_TOLERANCE) {
    return { status: "OVERPAID", orderStatus: "PAYMENT_OVERPAID", difference };
  }
  return { status: "CONFIRMED", orderStatus: "PAYMENT_CONFIRMED", difference };
}

export function isFulfillable(status: PaymentStatus): boolean {
  return status === "CONFIRMED" || status === "OVERPAID";
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  CREATED: "Created",
  RESERVED: "Reserved",
  PAYMENT_PENDING: "Awaiting payment",
  PAYMENT_DETECTED: "Payment detected",
  PAYMENT_CONFIRMED: "Payment confirmed",
  VOUCHER_DELIVERED: "Voucher delivered",
  COMPLETED: "Completed",
  PAYMENT_EXPIRED: "Payment expired",
  PAYMENT_UNDERPAID: "Underpaid",
  PAYMENT_OVERPAID: "Overpaid",
  PAYMENT_FAILED: "Payment failed",
  FULFILLMENT_FAILED: "Fulfilment failed",
  CANCELLED: "Cancelled",
  MANUAL_REVIEW: "Manual review",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  WAITING: "Waiting",
  DETECTED: "Detected",
  CONFIRMING: "Confirming",
  CONFIRMED: "Confirmed",
  UNDERPAID: "Underpaid",
  OVERPAID: "Overpaid",
  EXPIRED: "Expired",
  FAILED: "Failed",
  MANUAL_REVIEW: "Manual review",
};
