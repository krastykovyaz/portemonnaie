import { describe, expect, it } from "vitest";
import { compareReportedVsObserved } from "./verify-delegation";

describe("compareReportedVsObserved", () => {
  it("matches when TronGrid's observed delta equals Tronex's reported delegation exactly", () => {
    const result = compareReportedVsObserved({
      reportedDelegatedEnergy: 65000,
      observedEnergyBefore: 0,
      observedEnergyAfter: 65000,
    });
    expect(result.observedDelta).toBe(65000);
    expect(result.discrepancy).toBe(0);
    expect(result.matches).toBe(true);
  });

  it("reports the exact discrepancy when TronGrid shows less energy than Tronex claimed", () => {
    const result = compareReportedVsObserved({
      reportedDelegatedEnergy: 65000,
      observedEnergyBefore: 0,
      observedEnergyAfter: 60000,
    });
    expect(result.observedDelta).toBe(60000);
    expect(result.discrepancy).toBe(5000);
    expect(result.matches).toBe(false);
  });

  it("reports a negative discrepancy when TronGrid shows MORE energy than Tronex claimed", () => {
    const result = compareReportedVsObserved({
      reportedDelegatedEnergy: 65000,
      observedEnergyBefore: 0,
      observedEnergyAfter: 70000,
    });
    expect(result.discrepancy).toBe(-5000);
    expect(result.matches).toBe(false);
  });

  it("honors an explicit tolerance for small discrepancies from unrelated account activity", () => {
    const result = compareReportedVsObserved({
      reportedDelegatedEnergy: 65000,
      observedEnergyBefore: 0,
      observedEnergyAfter: 64950,
      toleranceEnergy: 100,
    });
    expect(result.discrepancy).toBe(50);
    expect(result.matches).toBe(true);
  });

  it("accounts for energy the account already had before the rental", () => {
    const result = compareReportedVsObserved({
      reportedDelegatedEnergy: 65000,
      observedEnergyBefore: 10000,
      observedEnergyAfter: 75000,
    });
    expect(result.observedDelta).toBe(65000);
    expect(result.matches).toBe(true);
  });
});
