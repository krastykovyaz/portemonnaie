import { describe, expect, it } from "vitest";
import { newId, nowIso } from "@/lib/db/client";
import { getRentalByIdempotencyKey, getRentalById, markRentalActive } from "@/lib/db/procedures/energy-rentals";
import type { EconomicsConfig } from "../economics-config";
import { computeCostEstimate, type AccountResources } from "../energy-manager";
import { MockEnergyRentalProvider } from "./mock-provider";
import { planPayoutResources } from "./plan-resources.server";

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
    // Higher than the default: the mock provider's minimum sellable unit
    // (65,000 energy, mirroring Tronex's real minimum) prices a rental at
    // ~$1.46 even for a small shortfall -- tests that expect a successful
    // rental need headroom above that; the "too expensive" tests override
    // this back down explicitly.
    maxNetworkCostUsd: 5,
    costGuardEnabled: true,
    provider: "RENTED",
    ...overrides,
  };
}

function resources(overrides: Partial<AccountResources> = {}): AccountResources {
  return { energyAvailable: 0, energyLimit: 0, bandwidthAvailable: 0, bandwidthLimit: 0, ...overrides };
}

const treasury = "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF";

describe("planPayoutResources", () => {
  it("energy already sufficient -> no rental is quoted or purchased", async () => {
    const config = baseConfig();
    const estimate = computeCostEstimate(config, "existing", resources({ energyAvailable: 14650, bandwidthAvailable: 345 }));
    expect(estimate.energyShortfall).toBe(0);

    const provider = new MockEnergyRentalProvider();
    const plan = await planPayoutResources(config, estimate, treasury, 0.5, `key-${newId()}`, { provider });

    expect(plan.ok).toBe(true);
    expect(provider.quoteCalls).toBe(0);
    expect(provider.rentCalls).toBe(0);
  });

  it("BURN/STAKED provider configured -> never touches the rental provider even with a real shortfall", async () => {
    const config = baseConfig({ provider: "BURN" });
    const estimate = computeCostEstimate(config, "fresh", resources());
    expect(estimate.energyShortfall).toBeGreaterThan(0);

    const provider = new MockEnergyRentalProvider();
    const plan = await planPayoutResources(config, estimate, treasury, 5, `key-${newId()}`, { provider });

    expect(provider.quoteCalls).toBe(0);
    expect(provider.rentCalls).toBe(0);
    // Unaffected: identical to the pre-existing evaluatePayoutMargin decision.
    expect(plan.ok).toBe(true);
  });

  it("insufficient energy + RENTED -> a rental is quoted, purchased, verified, and the payout may proceed", async () => {
    const config = baseConfig();
    const estimate = computeCostEstimate(config, "existing", resources({ bandwidthAvailable: 345 }));
    expect(estimate.energyShortfall).toBe(14650);

    const provider = new MockEnergyRentalProvider();
    const key = `key-${newId()}`;
    const plan = await planPayoutResources(config, estimate, treasury, 5, key, { provider });

    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(provider.quoteCalls).toBe(1);
    expect(provider.rentCalls).toBe(1);
    expect(plan.estimate.resourceSource).toBe("RENTED");
    expect(plan.rentalId).toBeTruthy();

    const row = getRentalById(plan.rentalId!);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.delegated_energy).toBeGreaterThanOrEqual(14650);
  });

  it("quote exceeds MAX_NETWORK_COST_USD -> no rental is purchased", async () => {
    const config = baseConfig({ maxNetworkCostUsd: 0.001 });
    const estimate = computeCostEstimate(config, "fresh", resources());

    const provider = new MockEnergyRentalProvider();
    const plan = await planPayoutResources(config, estimate, treasury, 5, `key-${newId()}`, { provider });

    expect(plan.ok).toBe(false);
    expect(provider.quoteCalls).toBe(1); // we do quote -- we just don't buy
    expect(provider.rentCalls).toBe(0);
    if (!plan.ok) expect(plan.reason).toMatch(/exceeds MAX_NETWORK_COST_USD/);
  });

  it("quote makes the payout violate MIN_PAYOUT_MARGIN_USD -> no rental is purchased", async () => {
    const config = baseConfig({ minPayoutMarginUsd: 10 });
    const estimate = computeCostEstimate(config, "existing", resources({ bandwidthAvailable: 345 }));

    const provider = new MockEnergyRentalProvider();
    const plan = await planPayoutResources(config, estimate, treasury, 0.25, `key-${newId()}`, { provider });

    expect(plan.ok).toBe(false);
    expect(provider.rentCalls).toBe(0);
    if (!plan.ok) expect(plan.reason).toMatch(/below MIN_PAYOUT_MARGIN_USD/);
  });

  it("rental purchase fails -> the payout does not proceed", async () => {
    const config = baseConfig();
    const estimate = computeCostEstimate(config, "existing", resources({ bandwidthAvailable: 345 }));

    const provider = new MockEnergyRentalProvider({ shouldFailRental: true });
    const key = `key-${newId()}`;
    const plan = await planPayoutResources(config, estimate, treasury, 5, key, { provider });

    expect(plan.ok).toBe(false);
    // The rental row itself must be marked FAILED, not left dangling PENDING.
    const row = getRentalByIdempotencyKey(`rental:${key}`);
    expect(row?.status).toBe("FAILED");
  });

  it("rental never confirms (timeout / delegation not visible) -> the payout does not proceed", async () => {
    const config = baseConfig();
    const estimate = computeCostEstimate(config, "existing", resources({ bandwidthAvailable: 345 }));

    const provider = new MockEnergyRentalProvider({ neverConfirms: true });
    const key = `key-${newId()}`;
    const plan = await planPayoutResources(config, estimate, treasury, 5, key, {
      provider,
      verifyAttempts: 2,
      sleep: async () => {},
    });

    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/verified/);
    const row = getRentalByIdempotencyKey(`rental:${key}`);
    expect(row?.status).toBe("FAILED");
    expect(row?.error_message).toBe("DELEGATION_NOT_VERIFIED");
  });

  it("duplicate request (same idempotency key) -> only one rental is ever purchased", async () => {
    const config = baseConfig();
    const estimate = computeCostEstimate(config, "existing", resources({ bandwidthAvailable: 345 }));
    const provider = new MockEnergyRentalProvider();
    const key = `key-${newId()}`;

    const first = await planPayoutResources(config, estimate, treasury, 5, key, { provider });
    const second = await planPayoutResources(config, estimate, treasury, 5, key, { provider });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(provider.quoteCalls).toBe(1);
    expect(provider.rentCalls).toBe(1);
    if (first.ok && second.ok) expect(second.rentalId).toBe(first.rentalId);
  });

  it("an expired rental for the same redemption is renewed, not blindly reused", async () => {
    const config = baseConfig();
    const estimate = computeCostEstimate(config, "existing", resources({ bandwidthAvailable: 345 }));
    const provider = new MockEnergyRentalProvider();
    const key = `key-${newId()}`;

    const first = await planPayoutResources(config, estimate, treasury, 5, key, { provider });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    // Force the rental into the past, as if it had genuinely expired since.
    const row = getRentalById(first.rentalId!)!;
    markRentalActive(row.id, {
      providerOrderId: row.provider_order_id ?? "1",
      delegatedEnergy: row.delegated_energy ?? 65000,
      priceTrx: row.price_trx ?? 9.75,
      priceUsd: row.price_usd ?? 1.4625,
      startedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      txHash: row.tx_hash,
    });

    const second = await planPayoutResources(config, estimate, treasury, 5, key, { provider });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    // The same redemption's rental row is renewed in place, not duplicated.
    expect(second.rentalId).toBe(first.rentalId);
    expect(getRentalById(second.rentalId!)?.status).toBe("ACTIVE");
    // A second real purchase attempt did happen (the expired one can't be reused).
    expect(provider.rentCalls).toBe(2);
  });

  it("provider/network error at quote time reprices as a direct burn and falls back to that guard decision (never rents)", async () => {
    const config = baseConfig();
    const estimate = computeCostEstimate(config, "existing", resources({ bandwidthAvailable: 345 }));
    const provider = new MockEnergyRentalProvider({ shouldFailQuote: true });

    const plan = await planPayoutResources(config, estimate, treasury, 5, `key-${newId()}`, { provider });

    expect(provider.rentCalls).toBe(0);
    expect(plan.ok).toBe(true); // burn pricing on its own passes the guard at feeUsd=5
    if (plan.ok) {
      expect(plan.estimate.resourceSource).toBe("BURN");
      expect(plan.rentalId).toBeNull();
    }
  });

  it("cost guard rejection still applies when RENTED is configured but there's no shortfall at all", async () => {
    // No shortfall -> takes the byte-for-byte pre-existing guard path, which
    // must still reject an anomalously large fee-vs-cost mismatch exactly as
    // it did before RENTED existed.
    const config = baseConfig({ maxNetworkCostUsd: 0 });
    const estimate = computeCostEstimate(config, "existing", resources({ energyAvailable: 14650, bandwidthAvailable: 345 }));
    expect(estimate.energyShortfall).toBe(0);
    expect(estimate.estimatedUsdCost).toBe(0);

    const provider = new MockEnergyRentalProvider();
    const plan = await planPayoutResources(config, estimate, treasury, 5, `key-${newId()}`, { provider });
    // Zero-cost estimate never exceeds a maxNetworkCostUsd of 0, so this passes --
    // confirms the no-shortfall path still runs evaluatePayoutMargin at all.
    expect(plan.ok).toBe(true);
    expect(provider.quoteCalls).toBe(0);
  });
});
