import type { EconomicsConfig, EnergyProviderKind } from "./economics-config";

export type RecipientKind = "fresh" | "existing";

export type AccountResources = {
  /** Energy available before the account would need to burn TRX or use a rented/staked pool for more. */
  energyAvailable: number;
  /** Account's own energy limit (0 if nothing staked/delegated). */
  energyLimit: number;
  bandwidthAvailable: number;
  bandwidthLimit: number;
};

export type CostEstimate = {
  recipientKind: RecipientKind;
  estimatedEnergy: number;
  estimatedBandwidth: number;
  /** Energy beyond what's available for free/staked — this portion is what actually costs money. */
  energyShortfall: number;
  bandwidthShortfall: number;
  resourceSource: EnergyProviderKind;
  /** TRX that would need to be burned/rented to cover the shortfalls, at the configured price. */
  estimatedTrxCost: number;
  estimatedUsdCost: number;
};

export interface EnergyManager {
  readonly provider: EnergyProviderKind;
  getAccountResources(address: string): Promise<AccountResources>;
  classifyRecipient(address: string): Promise<RecipientKind>;
  estimateCost(recipientKind: RecipientKind, resources: AccountResources): CostEstimate;
}

/**
 * Pure cost math shared by every provider implementation. Kept separate from
 * any network I/O so it's directly unit-testable and so estimate == actual
 * math never silently drifts between the "before broadcast" estimate and the
 * "after confirmation" reconciliation.
 */
export function computeCostEstimate(
  config: EconomicsConfig,
  recipientKind: RecipientKind,
  resources: AccountResources,
): CostEstimate {
  const estimatedEnergy =
    recipientKind === "fresh" ? config.energyFreshRecipient : config.energyExistingRecipient;
  const estimatedBandwidth = config.bandwidthPerTransfer;

  const energyShortfall = Math.max(0, estimatedEnergy - resources.energyAvailable);
  const bandwidthShortfall = Math.max(0, estimatedBandwidth - resources.bandwidthAvailable);

  const energyPriceSun =
    config.provider === "RENTED" ? config.energyRentalPriceSun : config.energyBurnPriceSun;
  // STAKED assumes the shortfall is covered by a delegation pool at ~zero
  // marginal TRX cost (the capital cost is amortized elsewhere, not per-tx).
  const energySunCost = config.provider === "STAKED" ? 0 : energyShortfall * energyPriceSun;
  const bandwidthSunCost = bandwidthShortfall * config.bandwidthPriceSun;

  const estimatedTrxCost = (energySunCost + bandwidthSunCost) / 1_000_000;
  const estimatedUsdCost = estimatedTrxCost * config.trxUsdPrice;

  return {
    recipientKind,
    estimatedEnergy,
    estimatedBandwidth,
    energyShortfall,
    bandwidthShortfall,
    resourceSource: config.provider,
    estimatedTrxCost,
    estimatedUsdCost,
  };
}

/**
 * Replaces a BURN/STAKED-priced estimate's cost with a real rental quote's
 * price once the payout has actually decided to rent. Pure -- the bandwidth
 * portion is still priced by the existing BURN formula (only Energy rental is
 * in scope here) and re-derived from `base`, never re-fetched.
 */
export function combineRentalEstimate(
  base: CostEstimate,
  quote: { priceTrx: number },
  config: EconomicsConfig,
): CostEstimate {
  const bandwidthTrxCost = (base.bandwidthShortfall * config.bandwidthPriceSun) / 1_000_000;
  const estimatedTrxCost = quote.priceTrx + bandwidthTrxCost;
  return {
    ...base,
    resourceSource: "RENTED",
    estimatedTrxCost,
    estimatedUsdCost: estimatedTrxCost * config.trxUsdPrice,
  };
}

/**
 * Reprices an estimate's shortfall as if burning TRX directly, ignoring
 * whatever provider produced it. Used as the conservative fallback when the
 * rental market can't be reached: BURN is the one resourcing path that never
 * depends on a third party, so it's always safe to fall back to it rather
 * than trusting a stale, unverified rental-flat estimate.
 */
export function repriceAsBurn(estimate: CostEstimate, config: EconomicsConfig): CostEstimate {
  const energySunCost = estimate.energyShortfall * config.energyBurnPriceSun;
  const bandwidthSunCost = estimate.bandwidthShortfall * config.bandwidthPriceSun;
  const estimatedTrxCost = (energySunCost + bandwidthSunCost) / 1_000_000;
  return {
    ...estimate,
    resourceSource: "BURN",
    estimatedTrxCost,
    estimatedUsdCost: estimatedTrxCost * config.trxUsdPrice,
  };
}

export type MarginDecision = {
  ok: boolean;
  reason: string | null;
  netMarginUsd: number;
  networkCostUsd: number;
};

/**
 * Cost guard evaluation — pure function, no I/O. `feeUsd` is the platform's
 * own revenue on this redemption (voucher amount * fee rate); the guard
 * checks the fee still covers the estimated network cost by at least the
 * configured minimum margin, and that the cost itself isn't anomalously
 * large regardless of margin (catches config/measurement errors).
 */
export function evaluatePayoutMargin(
  config: EconomicsConfig,
  feeUsd: number,
  estimate: CostEstimate,
): MarginDecision {
  if (!config.costGuardEnabled) {
    return { ok: true, reason: null, netMarginUsd: feeUsd - estimate.estimatedUsdCost, networkCostUsd: estimate.estimatedUsdCost };
  }
  if (estimate.estimatedUsdCost > config.maxNetworkCostUsd) {
    return {
      ok: false,
      reason: `Estimated network cost $${estimate.estimatedUsdCost.toFixed(4)} exceeds MAX_NETWORK_COST_USD ($${config.maxNetworkCostUsd})`,
      netMarginUsd: feeUsd - estimate.estimatedUsdCost,
      networkCostUsd: estimate.estimatedUsdCost,
    };
  }
  const netMarginUsd = feeUsd - estimate.estimatedUsdCost;
  if (netMarginUsd < config.minPayoutMarginUsd) {
    return {
      ok: false,
      reason: `Net margin $${netMarginUsd.toFixed(4)} (fee $${feeUsd.toFixed(4)} - network cost $${estimate.estimatedUsdCost.toFixed(4)}) is below MIN_PAYOUT_MARGIN_USD ($${config.minPayoutMarginUsd})`,
      netMarginUsd,
      networkCostUsd: estimate.estimatedUsdCost,
    };
  }
  return { ok: true, reason: null, netMarginUsd, networkCostUsd: estimate.estimatedUsdCost };
}
