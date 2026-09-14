import { TronWeb } from "tronweb";
import { economicsConfig } from "./economics-config";
import {
  computeCostEstimate,
  type AccountResources,
  type CostEstimate,
  type EnergyManager,
  type RecipientKind,
} from "./energy-manager";
import type { EnergyProviderKind } from "./economics-config";

export type TronEnergyManagerConfig = {
  apiUrl: string;
  apiKey?: string | null;
  contractAddress: string;
};

/**
 * Real Nile/TRON-backed EnergyManager. Read-only: it never signs or
 * broadcasts anything, only queries public chain state to estimate cost
 * before a payout and is never itself the source of "actual" figures after
 * confirmation (those come from the transaction receipt — see
 * resource-lookup.server.ts).
 */
export class TronEnergyManager implements EnergyManager {
  readonly provider: EnergyProviderKind;
  private readonly tronWeb: TronWeb;
  private readonly contractAddress: string;

  constructor(config: TronEnergyManagerConfig) {
    this.tronWeb = new TronWeb({
      fullHost: config.apiUrl,
      ...(config.apiKey ? { headers: { "TRON-PRO-API-KEY": config.apiKey } } : {}),
    });
    this.contractAddress = config.contractAddress;
    this.provider = economicsConfig().provider;
  }

  async getAccountResources(address: string): Promise<AccountResources> {
    try {
      const res = await this.tronWeb.trx.getAccountResources(address);
      return {
        energyAvailable: Math.max(0, (res.EnergyLimit ?? 0) - (res.EnergyUsed ?? 0)),
        energyLimit: res.EnergyLimit ?? 0,
        bandwidthAvailable: Math.max(
          0,
          (res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0) + (res.NetLimit ?? 0) - (res.NetUsed ?? 0),
        ),
        bandwidthLimit: (res.freeNetLimit ?? 0) + (res.NetLimit ?? 0),
      };
    } catch {
      // Fail safe: if we can't read resources, assume none are available so
      // the cost estimate is conservative (worst case) rather than optimistic.
      return { energyAvailable: 0, energyLimit: 0, bandwidthAvailable: 0, bandwidthLimit: 0 };
    }
  }

  async classifyRecipient(address: string): Promise<RecipientKind> {
    try {
      const contract = await this.tronWeb.contract().at(this.contractAddress);
      const raw = await contract["balanceOf"](address).call({ from: address });
      return Number(raw) > 0 ? "existing" : "fresh";
    } catch {
      // Fail safe: never underestimate — treat unknown as the more
      // expensive "fresh" case so the cost guard can't be fooled by a
      // transient read failure into approving an underpriced payout.
      return "fresh";
    }
  }

  estimateCost(recipientKind: RecipientKind, resources: AccountResources): CostEstimate {
    return computeCostEstimate(economicsConfig(), recipientKind, resources);
  }
}
