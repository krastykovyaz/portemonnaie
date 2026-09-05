import { describe, expect, it } from "vitest";
import {
  canOrderTransition,
  classifyPayment,
  isFulfillable,
  isOrderOpen,
  isOrderTerminal,
} from "./state-machine";

describe("order state machine", () => {
  it("allows the happy path and blocks skipping fulfilment", () => {
    expect(canOrderTransition("CREATED", "RESERVED")).toBe(true);
    expect(canOrderTransition("PAYMENT_CONFIRMED", "VOUCHER_DELIVERED")).toBe(true);
    expect(canOrderTransition("CREATED", "COMPLETED")).toBe(false);
  });

  it("treats completed and cancelled as terminal", () => {
    expect(isOrderTerminal("COMPLETED")).toBe(true);
    expect(isOrderTerminal("CANCELLED")).toBe(true);
    expect(isOrderOpen("PAYMENT_PENDING")).toBe(true);
    expect(isOrderOpen("COMPLETED")).toBe(false);
  });
});

describe("payment classification", () => {
  const base = { required: 50, requiredConfirmations: 3 };

  it("confirms an exact payment once confirmations are met", () => {
    const result = classifyPayment({ ...base, detected: 50, confirmations: 3 });
    expect(result.status).toBe("CONFIRMED");
    expect(isFulfillable(result.status)).toBe(true);
  });

  it("stays in confirming while under the confirmation threshold", () => {
    const result = classifyPayment({ ...base, detected: 50, confirmations: 1 });
    expect(["DETECTED", "CONFIRMING"]).toContain(result.status);
    expect(isFulfillable(result.status)).toBe(false);
  });

  it("flags underpayment and overpayment", () => {
    expect(classifyPayment({ ...base, detected: 25, confirmations: 3 }).status).toBe("UNDERPAID");
    const over = classifyPayment({ ...base, detected: 60, confirmations: 3 });
    expect(over.status).toBe("OVERPAID");
    expect(isFulfillable(over.status)).toBe(true);
  });

  it("tolerates dust-level differences", () => {
    expect(classifyPayment({ ...base, detected: 50.001, confirmations: 3 }).status).toBe(
      "CONFIRMED",
    );
  });
});
