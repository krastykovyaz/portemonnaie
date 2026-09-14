/**
 * Compares what Tronex's API claims it delegated against what an independent
 * TronGrid read of the treasury address's Energy actually shows before/after
 * -- the smoke test must never trust the provider's own report as proof.
 */
export type EnergyComparisonResult = {
  reportedDelegatedEnergy: number;
  observedEnergyBefore: number;
  observedEnergyAfter: number;
  observedDelta: number;
  /** reportedDelegatedEnergy - observedDelta. Zero means an exact match. */
  discrepancy: number;
  matches: boolean;
};

export function compareReportedVsObserved(input: {
  reportedDelegatedEnergy: number;
  observedEnergyBefore: number;
  observedEnergyAfter: number;
  /** Allows for other traffic on the same account between the two reads. Defaults to 0 (exact match required). */
  toleranceEnergy?: number;
}): EnergyComparisonResult {
  const observedDelta = input.observedEnergyAfter - input.observedEnergyBefore;
  const discrepancy = input.reportedDelegatedEnergy - observedDelta;
  const tolerance = input.toleranceEnergy ?? 0;
  return {
    reportedDelegatedEnergy: input.reportedDelegatedEnergy,
    observedEnergyBefore: input.observedEnergyBefore,
    observedEnergyAfter: input.observedEnergyAfter,
    observedDelta,
    discrepancy,
    matches: Math.abs(discrepancy) <= tolerance,
  };
}
