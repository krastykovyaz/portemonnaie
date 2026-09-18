import type { EconomicsConfig } from "./economics-config";

/** TRON's own hard ceiling for a single contract call. */
export const MAX_FEE_LIMIT_SUN = 100_000_000; // 100 TRX
/** Never go below this — a transfer that can't possibly cover bandwidth would just revert. */
export const MIN_FEE_LIMIT_SUN = 1_000_000; // 1 TRX

/**
 * The on-chain `feeLimit` for a payout, derived from the same cost guard the
 * pre-broadcast estimate is checked against. Before this the signer always
 * sent 100 TRX, so the guard's MAX_NETWORK_COST_USD was advisory only and a
 * mis-estimated transfer could burn ~15x the configured ceiling.
 */
export function feeLimitSunFromGuard(config: EconomicsConfig): number {
  if (!config.costGuardEnabled) return MAX_FEE_LIMIT_SUN;
  const trx = config.maxNetworkCostUsd / config.trxUsdPrice;
  if (!Number.isFinite(trx) || trx <= 0) return MIN_FEE_LIMIT_SUN;
  return Math.min(MAX_FEE_LIMIT_SUN, Math.max(MIN_FEE_LIMIT_SUN, Math.ceil(trx * 1_000_000)));
}
