import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ATTEMPTS,
  REQUIRED_CONFIRMATIONS,
  canFinalizeVoucher,
  canTransition,
  isRecoverable,
  isTerminal,
  shouldEscalateToManualReview,
} from "./state-machine";

describe("payout state machine", () => {
  it("walks the happy path", () => {
    expect(canTransition("PENDING", "BROADCAST")).toBe(true);
    expect(canTransition("BROADCAST", "CONFIRMING")).toBe(true);
    expect(canTransition("CONFIRMING", "CONFIRMED")).toBe(true);
  });

  it("never leaves a confirmed payout", () => {
    expect(canTransition("CONFIRMED", "PENDING")).toBe(false);
    expect(canTransition("CONFIRMED", "FAILED")).toBe(false);
    expect(isTerminal("CONFIRMED")).toBe(true);
  });

  it("allows retry from failed and manual review", () => {
    expect(canTransition("FAILED", "PENDING")).toBe(true);
    expect(canTransition("MANUAL_REVIEW", "PENDING")).toBe(true);
  });

  it("marks unfinished payouts for the recovery worker", () => {
    for (const status of ["NOT_STARTED", "PENDING", "BROADCAST", "CONFIRMING", "FAILED"] as const) {
      expect(isRecoverable(status)).toBe(true);
    }
    expect(isRecoverable("CONFIRMED")).toBe(false);
    expect(isRecoverable("MANUAL_REVIEW")).toBe(false);
  });

  it("only redeems a voucher after enough confirmations", () => {
    expect(canFinalizeVoucher("CONFIRMED", REQUIRED_CONFIRMATIONS)).toBe(true);
    expect(canFinalizeVoucher("CONFIRMED", REQUIRED_CONFIRMATIONS - 1)).toBe(false);
    expect(canFinalizeVoucher("CONFIRMING", 99)).toBe(false);
  });

  it("escalates after the attempt budget is spent", () => {
    expect(shouldEscalateToManualReview(DEFAULT_MAX_ATTEMPTS)).toBe(true);
    expect(shouldEscalateToManualReview(DEFAULT_MAX_ATTEMPTS - 1)).toBe(false);
  });
});
