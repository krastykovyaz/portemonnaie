import { describe, expect, it } from "vitest";
import {
  combineRentalEstimate,
  computeCostEstimate,
  evaluatePayoutMargin,
  repriceAsBurn,
  type AccountResources,
} from "./energy-manager";
import type { EconomicsConfig } from "./economics-config";

function baseConfig(overrides: Partial<EconomicsConfig> = {}): EconomicsConfig {
  return {
    bandwidthPriceSun: 1000,
    energyBurnPriceSun: 210,
    energyRentalPriceSun: 60,
    rentalDuration: "1h",
    trxUsdPrice: 0.15,
    energyExistingRecipient: 14650,
    energyFreshRecipient: 29650,
    bandwidthPerTransfer: 345,
    minPayoutMarginUsd: 0,
    maxNetworkCostUsd: 1,
    costGuardEnabled: true,
    provider: "BURN",
    ...overrides,
  };
}

function resources(overrides: Partial<AccountResources> = {}): AccountResources {
  return { energyAvailable: 0, energyLimit: 0, bandwidthAvailable: 0, bandwidthLimit: 0, ...overrides };
}

describe("computeCostEstimate", () => {
  it("existing recipient uses the lower (14,650) energy estimate", () => {
    const estimate = computeCostEstimate(baseConfig(), "existing", resources());
    expect(estimate.estimatedEnergy).toBe(14650);
    expect(estimate.recipientKind).toBe("existing");
  });

  it("fresh recipient uses the higher (29,650) energy estimate", () => {
    const estimate = computeCostEstimate(baseConfig(), "fresh", resources());
    expect(estimate.estimatedEnergy).toBe(29650);
    expect(estimate.recipientKind).toBe("fresh");
  });

  it("sufficient staked energy and bandwidth produces zero shortfall and zero cost", () => {
    const estimate = computeCostEstimate(
      baseConfig({ provider: "STAKED" }),
      "existing",
      resources({ energyAvailable: 50000, bandwidthAvailable: 1000 }),
    );
    expect(estimate.energyShortfall).toBe(0);
    expect(estimate.bandwidthShortfall).toBe(0);
    expect(estimate.estimatedTrxCost).toBe(0);
    expect(estimate.estimatedUsdCost).toBe(0);
  });

  it("insufficient energy computes a shortfall burned at the BURN price", () => {
    const estimate = computeCostEstimate(
      baseConfig({ provider: "BURN" }),
      "fresh",
      resources({ energyAvailable: 10000, bandwidthAvailable: 1000 }),
    );
    expect(estimate.energyShortfall).toBe(29650 - 10000);
    expect(estimate.bandwidthShortfall).toBe(0);
    const expectedTrx = ((29650 - 10000) * 210) / 1_000_000;
    expect(estimate.estimatedTrxCost).toBeCloseTo(expectedTrx, 8);
    expect(estimate.estimatedUsdCost).toBeCloseTo(expectedTrx * 0.15, 8);
  });

  it("insufficient bandwidth computes a shortfall on top of any energy shortfall", () => {
    const estimate = computeCostEstimate(
      baseConfig({ provider: "BURN" }),
      "existing",
      resources({ energyAvailable: 14650, bandwidthAvailable: 100 }),
    );
    expect(estimate.energyShortfall).toBe(0);
    expect(estimate.bandwidthShortfall).toBe(345 - 100);
    const expectedTrx = ((345 - 100) * 1000) / 1_000_000;
    expect(estimate.estimatedTrxCost).toBeCloseTo(expectedTrx, 8);
  });

  it("STAKED provider treats the energy shortfall as free (amortized elsewhere)", () => {
    const estimate = computeCostEstimate(
      baseConfig({ provider: "STAKED" }),
      "fresh",
      resources({ energyAvailable: 0, bandwidthAvailable: 1000 }),
    );
    expect(estimate.energyShortfall).toBe(29650);
    expect(estimate.estimatedTrxCost).toBe(0);
  });

  it("RENTED provider prices the energy shortfall at the rental rate, not the burn rate", () => {
    const estimate = computeCostEstimate(
      baseConfig({ provider: "RENTED" }),
      "fresh",
      resources({ energyAvailable: 0, bandwidthAvailable: 1000 }),
    );
    const expectedTrx = (29650 * 60) / 1_000_000;
    expect(estimate.estimatedTrxCost).toBeCloseTo(expectedTrx, 8);
  });
});

describe("combineRentalEstimate / repriceAsBurn", () => {
  it("combineRentalEstimate replaces the energy cost with the quote's price but still burn-prices any bandwidth shortfall", () => {
    const config = baseConfig();
    const base = computeCostEstimate(config, "existing", resources({ bandwidthAvailable: 100 }));
    const combined = combineRentalEstimate(base, { priceTrx: 9.75 }, config);
    expect(combined.resourceSource).toBe("RENTED");
    const expectedBandwidthTrx = ((345 - 100) * 1000) / 1_000_000;
    expect(combined.estimatedTrxCost).toBeCloseTo(9.75 + expectedBandwidthTrx, 8);
    expect(combined.estimatedUsdCost).toBeCloseTo(combined.estimatedTrxCost * 0.15, 8);
  });

  it("repriceAsBurn ignores whatever provider produced the estimate and always burn-prices the shortfall", () => {
    const config = baseConfig({ provider: "RENTED" });
    const rentalPriced = computeCostEstimate(config, "fresh", resources());
    const burned = repriceAsBurn(rentalPriced, config);
    expect(burned.resourceSource).toBe("BURN");
    const expectedTrx = (29650 * 210 + 345 * 1000) / 1_000_000;
    expect(burned.estimatedTrxCost).toBeCloseTo(expectedTrx, 8);
  });
});

describe("evaluatePayoutMargin — cost guard", () => {
  it("approves a payout whose estimated cost stays comfortably under the fee", () => {
    const estimate = computeCostEstimate(
      baseConfig(),
      "existing",
      resources({ energyAvailable: 14650, bandwidthAvailable: 345 }),
    );
    const decision = evaluatePayoutMargin(baseConfig(), 0.5, estimate);
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it("rejects when estimated network cost exceeds MAX_NETWORK_COST_USD", () => {
    const config = baseConfig({ maxNetworkCostUsd: 0.01 });
    const estimate = computeCostEstimate(config, "fresh", resources());
    const decision = evaluatePayoutMargin(config, 5, estimate);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/exceeds MAX_NETWORK_COST_USD/);
  });

  it("rejects (routes to manual review) when the net margin falls below MIN_PAYOUT_MARGIN_USD", () => {
    const config = baseConfig({ minPayoutMarginUsd: 1 });
    const estimate = computeCostEstimate(config, "existing", resources());
    const decision = evaluatePayoutMargin(config, 0.1, estimate);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/below MIN_PAYOUT_MARGIN_USD/);
  });

  it("fails safe: when the cost guard is disabled it always approves regardless of cost", () => {
    const config = baseConfig({ costGuardEnabled: false, maxNetworkCostUsd: 0 });
    const estimate = computeCostEstimate(config, "fresh", resources());
    const decision = evaluatePayoutMargin(config, 0, estimate);
    expect(decision.ok).toBe(true);
  });

  it("default config (guard enabled) rejects when a low-value voucher's fee can't cover network cost", () => {
    const config = baseConfig(); // defaults: minPayoutMarginUsd = 0, guard enabled
    // Fresh recipient with zero available resources burns real TRX for both
    // energy and bandwidth (~$0.99 at the default price assumptions) -- a
    // $10 voucher's 1% fee ($0.10) doesn't come close to covering that, so
    // the fail-safe default must route it to manual review.
    const estimate = computeCostEstimate(config, "fresh", resources({ energyAvailable: 0, bandwidthAvailable: 0 }));
    const feeUsd = 0.1;
    const decision = evaluatePayoutMargin(config, feeUsd, estimate);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/below MIN_PAYOUT_MARGIN_USD/);
  });
});
