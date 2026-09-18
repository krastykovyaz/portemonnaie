import { describe, expect, it } from "vitest";
import type { EconomicsConfig } from "./economics-config";
import { MAX_FEE_LIMIT_SUN, MIN_FEE_LIMIT_SUN, feeLimitSunFromGuard } from "./fee-limit";

function config(overrides: Partial<EconomicsConfig> = {}): EconomicsConfig {
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

describe("feeLimitSunFromGuard", () => {
  it("converts MAX_NETWORK_COST_USD into sun at the configured TRX price", () => {
    // $1 / $0.15 per TRX = 6.666… TRX
    expect(feeLimitSunFromGuard(config())).toBe(6_666_667);
  });

  it("caps at TRON's 100 TRX ceiling", () => {
    expect(feeLimitSunFromGuard(config({ maxNetworkCostUsd: 1_000 }))).toBe(MAX_FEE_LIMIT_SUN);
  });

  it("never drops below 1 TRX even for an absurdly low guard", () => {
    expect(feeLimitSunFromGuard(config({ maxNetworkCostUsd: 0.0001 }))).toBe(MIN_FEE_LIMIT_SUN);
    expect(feeLimitSunFromGuard(config({ maxNetworkCostUsd: 0 }))).toBe(MIN_FEE_LIMIT_SUN);
  });

  it("falls back to the ceiling when the guard is disabled", () => {
    expect(feeLimitSunFromGuard(config({ costGuardEnabled: false }))).toBe(MAX_FEE_LIMIT_SUN);
  });
});
