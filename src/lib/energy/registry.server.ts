import { resolveRuntime } from "../providers/registry.server";
import { TronEnergyManager } from "./tron-energy-manager.server";
import type { AccountResources, CostEstimate, EnergyManager, RecipientKind } from "./energy-manager";

/**
 * Used only for the simulated payout provider — no real chain exists to
 * query, so resources are unlimited and cost is always zero. The real cost
 * guard / accounting pipeline in redemption.server.ts skips this entirely
 * for simulated payouts rather than routing them through here; this class
 * exists mainly so callers always get a valid EnergyManager and never need
 * to null-check the simulated case themselves.
 */
class NullEnergyManager implements EnergyManager {
  readonly provider = "BURN" as const;
  async getAccountResources(): Promise<AccountResources> {
    return {
      energyAvailable: Number.POSITIVE_INFINITY,
      energyLimit: Number.POSITIVE_INFINITY,
      bandwidthAvailable: Number.POSITIVE_INFINITY,
      bandwidthLimit: Number.POSITIVE_INFINITY,
    };
  }
  async classifyRecipient(): Promise<RecipientKind> {
    return "existing";
  }
  estimateCost(recipientKind: RecipientKind): CostEstimate {
    return {
      recipientKind,
      estimatedEnergy: 0,
      estimatedBandwidth: 0,
      energyShortfall: 0,
      bandwidthShortfall: 0,
      resourceSource: "BURN",
      estimatedTrxCost: 0,
      estimatedUsdCost: 0,
    };
  }
}

/** Resolve the active EnergyManager from server env. Call inside handlers only. */
export function resolveEnergyManager(): EnergyManager {
  const runtime = resolveRuntime();
  if (runtime.payoutProvider.simulated) return new NullEnergyManager();
  return new TronEnergyManager({
    apiUrl: process.env["TRON_API_URL"] ?? "https://nile.trongrid.io",
    apiKey: process.env["TRON_API_KEY"] ?? null,
    contractAddress: process.env["USDT_CONTRACT_ADDRESS"] ?? "",
  });
}
