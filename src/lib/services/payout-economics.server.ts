import { db } from "@/lib/db/client";
import { getLatestRental, getRentalStats } from "@/lib/db/procedures/energy-rentals";
import { resolveRuntime } from "../providers/registry.server";
import { resolveEnergyManager } from "../energy/registry.server";
import { resolveEnergyRentalProvider } from "../energy/rental/registry.server";
import { economicsConfig } from "../energy/economics-config";
import { FEE_RATE, DENOMINATIONS } from "../domain/types";

export type PayoutCostStats = {
  count: number;
  avgEnergy: number | null;
  avgBandwidth: number | null;
  avgTrxBurned: number | null;
  avgNetworkCostUsd: number | null;
  totalNetworkCostUsd: number;
  totalUsdtPaid: number;
};

type CostRow = {
  n: number;
  avg_energy: number | null;
  avg_bandwidth: number | null;
  avg_trx: number | null;
  avg_cost: number | null;
  total_cost: number | null;
  total_amount: number | null;
};

function toStats(row: CostRow | null): PayoutCostStats {
  return {
    count: row?.n ?? 0,
    avgEnergy: row?.avg_energy ?? null,
    avgBandwidth: row?.avg_bandwidth ?? null,
    avgTrxBurned: row?.avg_trx ?? null,
    avgNetworkCostUsd: row?.avg_cost ?? null,
    totalNetworkCostUsd: row?.total_cost ?? 0,
    totalUsdtPaid: row?.total_amount ?? 0,
  };
}

/** Real, confirmed payouts only — this is realized cost, not estimates. */
const CONFIRMED_REAL = `status = 'CONFIRMED' AND provider <> 'mock-tron-testnet' AND total_network_cost IS NOT NULL`;

function costQuery(extraWhere = ""): CostRow | null {
  return db
    .query(
      `SELECT COUNT(*) AS n, AVG(actual_energy) AS avg_energy, AVG(actual_bandwidth) AS avg_bandwidth,
              AVG(trx_burned) AS avg_trx, AVG(total_network_cost) AS avg_cost,
              SUM(total_network_cost) AS total_cost, SUM(amount) AS total_amount
       FROM payouts WHERE ${CONFIRMED_REAL} ${extraWhere}`,
    )
    .get() as CostRow | null;
}

export type PayoutMetrics = {
  overall: PayoutCostStats;
  fresh: PayoutCostStats;
  existing: PayoutCostStats;
  last24h: PayoutCostStats;
  last7d: PayoutCostStats;
  last30d: PayoutCostStats;
  successCount: number;
  failureCount: number;
  manualReviewCount: number;
};

export function getPayoutMetrics(): PayoutMetrics {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  const statusCounts = db
    .query(
      `SELECT status, COUNT(*) AS n FROM payouts WHERE provider <> 'mock-tron-testnet' GROUP BY status`,
    )
    .all() as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row.status] = row.n;

  return {
    overall: toStats(costQuery()),
    fresh: toStats(costQuery(`AND recipient_kind = 'fresh'`)),
    existing: toStats(costQuery(`AND recipient_kind = 'existing'`)),
    last24h: toStats(costQuery(`AND confirmed_at >= '${iso(24 * 60 * 60 * 1000)}'`)),
    last7d: toStats(costQuery(`AND confirmed_at >= '${iso(7 * 24 * 60 * 60 * 1000)}'`)),
    last30d: toStats(costQuery(`AND confirmed_at >= '${iso(30 * 24 * 60 * 60 * 1000)}'`)),
    successCount: byStatus["CONFIRMED"] ?? 0,
    failureCount: byStatus["FAILED"] ?? 0,
    manualReviewCount: byStatus["MANUAL_REVIEW"] ?? 0,
  };
}

export type TreasuryStatus = {
  simulated: boolean;
  trxBalance: number | null;
  usdtBalance: number | null;
  energyAvailable: number | null;
  energyLimit: number | null;
  bandwidthAvailable: number | null;
  bandwidthLimit: number | null;
};

export async function getTreasuryStatus(): Promise<TreasuryStatus> {
  const runtime = resolveRuntime();
  if (runtime.payoutProvider.simulated) {
    return {
      simulated: true,
      trxBalance: null,
      usdtBalance: null,
      energyAvailable: null,
      energyLimit: null,
      bandwidthAvailable: null,
      bandwidthLimit: null,
    };
  }
  const treasuryAddress = process.env["TREASURY_ADDRESS"] ?? "";
  const apiUrl = process.env["TRON_API_URL"] ?? "https://nile.trongrid.io";
  const energyManager = resolveEnergyManager();
  const [resources, usdtBalance] = await Promise.all([
    energyManager.getAccountResources(treasuryAddress),
    runtime.payoutProvider.getBalance("USDT").catch(() => null),
  ]);

  let trxBalance: number | null = null;
  try {
    const res = await fetch(`${apiUrl}/v1/accounts/${treasuryAddress}`);
    const json = (await res.json()) as { data?: Array<{ balance?: number }> };
    trxBalance = json.data?.[0]?.balance !== undefined ? json.data[0].balance / 1e6 : null;
  } catch {
    trxBalance = null;
  }

  return {
    simulated: false,
    trxBalance,
    usdtBalance,
    energyAvailable: Number.isFinite(resources.energyAvailable) ? resources.energyAvailable : null,
    energyLimit: Number.isFinite(resources.energyLimit) ? resources.energyLimit : null,
    bandwidthAvailable: Number.isFinite(resources.bandwidthAvailable)
      ? resources.bandwidthAvailable
      : null,
    bandwidthLimit: Number.isFinite(resources.bandwidthLimit) ? resources.bandwidthLimit : null,
  };
}

export type DenominationProjection = {
  denomination: number;
  feeUsd: number;
  avgNetworkCostUsd: number | null;
  netMarginUsd: number | null;
  costAsPctOfVoucher: number | null;
};

export type EnergyRentalStatus = {
  provider: string;
  stats: { total: number; active: number; failed: number; expired: number };
  lastRental: {
    provider: string;
    delegatedEnergy: number | null;
    priceTrx: number | null;
    priceUsd: number | null;
    status: string;
    expiresAt: string | null;
    createdAt: string;
  } | null;
};

function getEnergyRentalStatus(): EnergyRentalStatus {
  // Read-only, no network I/O: resolveEnergyRentalProvider() only picks a
  // constructor, it never calls out -- safe to resolve just for its id here.
  const provider = resolveEnergyRentalProvider();
  const latest = getLatestRental();
  return {
    provider: provider.id,
    stats: getRentalStats(),
    lastRental: latest
      ? {
          provider: latest.provider,
          delegatedEnergy: latest.delegated_energy,
          priceTrx: latest.price_trx,
          priceUsd: latest.price_usd,
          status: latest.status,
          expiresAt: latest.expires_at,
          createdAt: latest.created_at,
        }
      : null,
  };
}

export type PayoutEconomicsReport = {
  treasury: TreasuryStatus;
  metrics: PayoutMetrics;
  byDenomination: DenominationProjection[];
  projected: { per100: number | null; per1000: number | null; per10000: number | null };
  config: ReturnType<typeof economicsConfig>;
  rental: EnergyRentalStatus;
};

export async function getPayoutEconomicsReport(): Promise<PayoutEconomicsReport> {
  const treasury = await getTreasuryStatus();
  const metrics = getPayoutMetrics();
  const avgCost = metrics.overall.avgNetworkCostUsd;

  const byDenomination: DenominationProjection[] = DENOMINATIONS.map((denomination) => {
    const feeUsd = Math.round(denomination * FEE_RATE * 100) / 100;
    const netMarginUsd = avgCost !== null ? feeUsd - avgCost : null;
    const costAsPctOfVoucher = avgCost !== null ? (avgCost / denomination) * 100 : null;
    return { denomination, feeUsd, avgNetworkCostUsd: avgCost, netMarginUsd, costAsPctOfVoucher };
  });

  return {
    treasury,
    metrics,
    byDenomination,
    projected: {
      per100: avgCost !== null ? avgCost * 100 : null,
      per1000: avgCost !== null ? avgCost * 1000 : null,
      per10000: avgCost !== null ? avgCost * 10000 : null,
    },
    config: economicsConfig(),
    rental: getEnergyRentalStatus(),
  };
}
