import { describe, expect, it } from "vitest";
import { checkSpendingCeiling } from "./spending-ceiling";

describe("checkSpendingCeiling", () => {
  it("fails closed when TRONEX_TEST_MAX_COST_USD is not set at all", () => {
    const decision = checkSpendingCeiling(0.5, undefined);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/not configured/);
  });

  it("fails closed when TRONEX_TEST_MAX_COST_USD is an empty string", () => {
    const decision = checkSpendingCeiling(0.5, "   ");
    expect(decision.ok).toBe(false);
  });

  it("fails closed when TRONEX_TEST_MAX_COST_USD is not a valid positive number", () => {
    expect(checkSpendingCeiling(0.5, "not-a-number").ok).toBe(false);
    expect(checkSpendingCeiling(0.5, "-1").ok).toBe(false);
    expect(checkSpendingCeiling(0.5, "0").ok).toBe(false);
  });

  it("rejects a quote that exceeds the configured ceiling", () => {
    const decision = checkSpendingCeiling(5, "1");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/exceeds TRONEX_TEST_MAX_COST_USD/);
  });

  it("approves a quote at or below the configured ceiling", () => {
    expect(checkSpendingCeiling(1, "1")).toEqual({ ok: true, ceilingUsd: 1 });
    expect(checkSpendingCeiling(0.5, "1")).toEqual({ ok: true, ceilingUsd: 1 });
  });
});
