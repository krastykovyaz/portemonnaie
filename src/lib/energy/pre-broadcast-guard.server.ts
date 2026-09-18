import { FEE_RATE } from "../domain/types";
import { economicsConfig, type EconomicsConfig } from "./economics-config";
import { computeCostEstimate, type EnergyManager, type RecipientKind } from "./energy-manager";
import { resolveEnergyManager } from "./registry.server";
import { planPayoutResources } from "./rental/plan-resources.server";
import type { EnergyRentalProvider } from "./rental/types";

type Estimated = {
  recipientKind: RecipientKind;
  estimatedEnergy: number;
  estimatedBandwidth: number;
  resourceSource: string;
};

export type ResourceAssessment =
  | ({ ok: true; rentalId: string | null } & Estimated)
  | ({ ok: false; reason: string } & Estimated);

export type AssessmentDeps = {
  energyManager?: EnergyManager;
  rentalProvider?: EnergyRentalProvider;
  config?: EconomicsConfig;
  treasuryAddress?: string;
};

/**
 * The one pre-broadcast cost check, shared by every path that can put a
 * real transfer on chain: the customer's own redeem call, an admin retry,
 * and the recovery sweep. Previously only redeem ran it, so a payout retried
 * from MANUAL_REVIEW or picked up by the sweep broadcast unguarded.
 *
 * Deps are injectable for deterministic tests; production resolves them
 * from the runtime.
 */
export async function assessPayoutResources(
  input: { destination: string; amount: number; idempotencyKey: string },
  deps: AssessmentDeps = {},
): Promise<ResourceAssessment> {
  const energyManager = deps.energyManager ?? resolveEnergyManager();
  const config = deps.config ?? economicsConfig();
  const treasury = deps.treasuryAddress ?? process.env["TREASURY_ADDRESS"] ?? "";

  const recipientKind = await energyManager.classifyRecipient(input.destination);
  const resources = await energyManager.getAccountResources(treasury);
  const estimate = computeCostEstimate(config, recipientKind, resources);
  const feeUsd = Math.round(input.amount * FEE_RATE * 100) / 100;

  const plan = await planPayoutResources(
    config,
    estimate,
    treasury,
    feeUsd,
    input.idempotencyKey,
    deps.rentalProvider ? { provider: deps.rentalProvider } : {},
  );

  const base = {
    recipientKind,
    estimatedEnergy: estimate.estimatedEnergy,
    estimatedBandwidth: estimate.estimatedBandwidth,
  };
  if (!plan.ok) {
    return { ok: false, reason: plan.reason, ...base, resourceSource: estimate.resourceSource };
  }
  return { ok: true, ...base, resourceSource: plan.estimate.resourceSource, rentalId: plan.rentalId };
}
