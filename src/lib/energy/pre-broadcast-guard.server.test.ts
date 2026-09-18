import { describe, expect, it } from "vitest";
import { newId } from "@/lib/db/client";
import type { EconomicsConfig } from "./economics-config";
import type { AccountResources, EnergyManager, RecipientKind } from "./energy-manager";
import { computeCostEstimate } from "./energy-manager";
import { assessPayoutResources } from "./pre-broadcast-guard.server";

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

function fakeEnergyManager(kind: RecipientKind, resources: AccountResources): EnergyManager {
  return {
    provider: "BURN",
    async getAccountResources() {
      return resources;
    },
    async classifyRecipient() {
      return kind;
    },
    estimateCost(recipientKind, res) {
      return computeCostEstimate(config(), recipientKind, res);
    },
  };
}

const zero: AccountResources = { energyAvailable: 0, energyLimit: 0, bandwidthAvailable: 0, bandwidthLimit: 0 };
const plenty: AccountResources = { energyAvailable: 100_000, energyLimit: 100_000, bandwidthAvailable: 5_000, bandwidthLimit: 5_000 };

describe("assessPayoutResources — shared pre-broadcast cost guard", () => {
  it("approves when the treasury already has the resources (zero network cost)", async () => {
    const result = await assessPayoutResources(
      { destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF", amount: 25, idempotencyKey: `k-${newId()}` },
      { energyManager: fakeEnergyManager("existing", plenty), config: config(), treasuryAddress: "T-treasury" },
    );
    expect(result.ok).toBe(true);
    expect(result.recipientKind).toBe("existing");
    expect(result.estimatedEnergy).toBe(14650);
    expect(result.resourceSource).toBe("BURN");
  });

  it("rejects with the guard's reason when a fresh recipient would blow the max network cost", async () => {
    const result = await assessPayoutResources(
      { destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF", amount: 10, idempotencyKey: `k-${newId()}` },
      {
        energyManager: fakeEnergyManager("fresh", zero),
        config: config({ maxNetworkCostUsd: 0.01 }),
        treasuryAddress: "T-treasury",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exceeds MAX_NETWORK_COST_USD/);
    expect(result.recipientKind).toBe("fresh");
    expect(result.estimatedEnergy).toBe(29650);
  });

  it("rejects when the fee can't cover the burn (margin guard), independent of the max-cost check", async () => {
    // $10 voucher -> $0.10 fee; fresh recipient burn at zero resources ≈ $0.99.
    const result = await assessPayoutResources(
      { destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF", amount: 10, idempotencyKey: `k-${newId()}` },
      { energyManager: fakeEnergyManager("fresh", zero), config: config({ maxNetworkCostUsd: 5 }), treasuryAddress: "T" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/below MIN_PAYOUT_MARGIN_USD/);
  });
});
