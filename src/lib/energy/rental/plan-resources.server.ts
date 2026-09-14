import { nowIso } from "@/lib/db/client";
import {
  createPendingRental,
  expireStaleRentals,
  getRentalByIdempotencyKey,
  markRentalActive,
  markRentalFailed,
} from "@/lib/db/procedures/energy-rentals";
import { payoutLog } from "@/lib/services/payout.server";
import type { EconomicsConfig } from "../economics-config";
import { combineRentalEstimate, evaluatePayoutMargin, repriceAsBurn, type CostEstimate } from "../energy-manager";
import { resolveEnergyRentalProvider } from "./registry.server";
import type { EnergyRentalProvider, RentalResult } from "./types";

export type ResourcePlan =
  | { ok: true; estimate: CostEstimate; rentalId: string | null }
  | { ok: false; reason: string };

type PlanOptions = {
  /** Injectable for tests -- production uses the real defaults. */
  verifyAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  provider?: EnergyRentalProvider;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function verifyDelegation(
  provider: EnergyRentalProvider,
  rentalId: string,
  options: PlanOptions,
): Promise<RentalResult | null> {
  const attempts = options.verifyAttempts ?? 3;
  const sleep = options.sleep ?? (async () => {});
  for (let i = 0; i < attempts; i++) {
    const status = await provider.getRentalStatus(rentalId);
    if (status?.status === "ACTIVE") return status;
    if (i < attempts - 1) await sleep(1000);
  }
  return null;
}

/**
 * Decides how (or whether) to resource a payout's Energy shortfall, then
 * carries it out. Guarantees, in order:
 *
 *  1. Sufficient resources already, or the operator hasn't opted into RENTED
 *     -> byte-for-byte the pre-existing BURN/STAKED guard decision. Zero
 *     behavior change for the default configuration.
 *  2. RENTED with a real shortfall -> quote, guard-check the REAL quoted
 *     price (not the flat estimate), rent only on approval, verify the
 *     delegation actually landed, and only then approve the payout.
 *  3. Any failure along the way (quote unavailable, rental rejected by the
 *     guard, rental purchase failed, delegation never verified) either falls
 *     back to the original BURN-priced guard decision (quote-stage failures
 *     only -- burning is always at least as conservative as a hoped-for
 *     rental) or fails the payout outright (post-purchase failures -- once
 *     money may have moved, never guess: same MANUAL_REVIEW path as the
 *     ordinary cost guard).
 */
export async function planPayoutResources(
  config: EconomicsConfig,
  estimate: CostEstimate,
  treasuryAddress: string,
  feeUsd: number,
  idempotencyKey: string,
  options: PlanOptions = {},
): Promise<ResourcePlan> {
  if (estimate.energyShortfall === 0 || config.provider !== "RENTED") {
    const decision = evaluatePayoutMargin(config, feeUsd, estimate);
    return decision.ok
      ? { ok: true, estimate, rentalId: null }
      : { ok: false, reason: decision.reason ?? "Cost guard rejected this payout" };
  }

  const provider = options.provider ?? resolveEnergyRentalProvider();
  const rentalKey = `rental:${idempotencyKey}`;

  // Sweep first so a rental that expired between purchase and this retry is
  // never mistaken for a still-usable delegation.
  expireStaleRentals();

  // Retry of a redemption whose rental already succeeded: reuse it, never
  // purchase a second one for the same payout.
  const existing = getRentalByIdempotencyKey(rentalKey);
  if (existing && existing.status === "ACTIVE") {
    const rentedEstimate = combineRentalEstimate(estimate, { priceTrx: existing.price_trx ?? 0 }, config);
    const decision = evaluatePayoutMargin(config, feeUsd, rentedEstimate);
    return decision.ok
      ? { ok: true, estimate: rentedEstimate, rentalId: existing.id }
      : { ok: false, reason: decision.reason ?? "Cost guard rejected this payout" };
  }

  let quote;
  try {
    payoutLog("ENERGY_QUOTE_REQUESTED", {
      provider: provider.id,
      treasuryAddress,
      requiredEnergy: estimate.energyShortfall,
    });
    quote = await provider.getQuote({
      targetAddress: treasuryAddress,
      requiredEnergy: estimate.energyShortfall,
      duration: config.rentalDuration,
    });
    payoutLog("ENERGY_QUOTE_RECEIVED", {
      provider: provider.id,
      quotedEnergy: quote.quotedEnergy,
      priceTrx: quote.priceTrx,
    });
  } catch (error) {
    // Provider unavailable / quote failed: don't rent, don't guess. Reprice
    // the shortfall as a direct TRX burn -- the one resourcing path that
    // never depends on a third party -- and guard-check THAT, rather than
    // trusting the stale, unverified flat RENTED estimate (which can be
    // cheaper than burning and would understate real risk here).
    payoutLog("ENERGY_RENTAL_FAILED", { stage: "QUOTE", provider: provider.id, error: message(error) });
    const burnEstimate = repriceAsBurn(estimate, config);
    const decision = evaluatePayoutMargin(config, feeUsd, burnEstimate);
    return decision.ok
      ? { ok: true, estimate: burnEstimate, rentalId: null }
      : { ok: false, reason: decision.reason ?? "Cost guard rejected this payout" };
  }

  const rentedEstimate = combineRentalEstimate(estimate, quote, config);
  const decision = evaluatePayoutMargin(config, feeUsd, rentedEstimate);
  if (!decision.ok) {
    // Quote too expensive, or it would violate the margin guard -- do not rent.
    return { ok: false, reason: decision.reason ?? "Cost guard rejected this payout" };
  }

  const { rental, created } = createPendingRental({
    provider: provider.id,
    treasuryAddress,
    requestedEnergy: estimate.energyShortfall,
    duration: config.rentalDuration,
    idempotencyKey: rentalKey,
  });
  if (!created && rental.status === "ACTIVE") {
    // Lost a race with a concurrent retry that already completed the purchase.
    const raced = combineRentalEstimate(estimate, { priceTrx: rental.price_trx ?? 0 }, config);
    return { ok: true, estimate: raced, rentalId: rental.id };
  }

  try {
    payoutLog("ENERGY_RENTAL_REQUESTED", {
      provider: provider.id,
      rentalId: rental.id,
      energy: quote.quotedEnergy,
    });
    const result = await provider.rentEnergy({
      targetAddress: treasuryAddress,
      energy: quote.quotedEnergy,
      duration: config.rentalDuration,
      idempotencyKey: rentalKey,
    });

    const verified = await verifyDelegation(provider, result.rentalId, options);
    if (!verified) {
      markRentalFailed(rental.id, "DELEGATION_NOT_VERIFIED");
      payoutLog("ENERGY_RENTAL_FAILED", { stage: "VERIFY", provider: provider.id, rentalId: rental.id });
      return { ok: false, reason: "Energy rental could not be verified on-chain before payout" };
    }

    const priceUsd = verified.priceTrx * config.trxUsdPrice;
    markRentalActive(rental.id, {
      providerOrderId: verified.rentalId,
      delegatedEnergy: verified.delegatedEnergy,
      priceTrx: verified.priceTrx,
      priceUsd,
      startedAt: result.startedAt || nowIso(),
      expiresAt: result.expiresAt || nowIso(),
      txHash: verified.txHash,
    });
    payoutLog("ENERGY_RENTAL_CONFIRMED", {
      provider: provider.id,
      rentalId: rental.id,
      delegatedEnergy: verified.delegatedEnergy,
    });
    payoutLog("ENERGY_DELEGATION_VERIFIED", { provider: provider.id, rentalId: rental.id });

    const finalEstimate = combineRentalEstimate(estimate, { priceTrx: verified.priceTrx }, config);
    return { ok: true, estimate: finalEstimate, rentalId: rental.id };
  } catch (error) {
    markRentalFailed(rental.id, message(error));
    payoutLog("ENERGY_RENTAL_FAILED", {
      stage: "RENT",
      provider: provider.id,
      rentalId: rental.id,
      error: message(error),
    });
    return { ok: false, reason: "Energy rental failed -- payout requires manual review" };
  }
}
