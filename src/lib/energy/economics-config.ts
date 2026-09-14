/**
 * Cost-model configuration. Every price here is an OPERATOR-SUPPLIED ESTIMATE
 * unless documented otherwise — this module never fetches a live market
 * price. Values are derived from the real Nile testnet benchmark performed
 * on 2026-09-06 (100 real payouts, 50 fresh + 50 existing recipients) unless
 * overridden via env.
 */

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() === "true";
}

export type EnergyProviderKind = "STAKED" | "RENTED" | "BURN";

export function activeEnergyProvider(): EnergyProviderKind {
  const raw = (process.env["ENERGY_PROVIDER"] ?? "BURN").trim().toUpperCase();
  if (raw === "STAKED" || raw === "RENTED" || raw === "BURN") return raw;
  return "BURN";
}

export type RentalDuration = "1h" | "1d" | "3d" | "7d";

function rentalDuration(): RentalDuration {
  const raw = (process.env["ENERGY_RENTAL_DURATION"] ?? "1h").trim();
  if (raw === "1h" || raw === "1d" || raw === "3d" || raw === "7d") return raw;
  return "1h";
}

export type EconomicsConfig = {
  /** sun per bandwidth point. Protocol-fixed on TRON, not an estimate: 1000. */
  bandwidthPriceSun: number;
  /** sun per energy unit when burning TRX directly (BURN provider). Estimate — no live feed. */
  energyBurnPriceSun: number;
  /** sun per energy unit when using a rental provider (RENTED), used only for the fast pre-flight estimate shown before a live quote is fetched. The real cost guard decision uses the actual quote from the rental provider — see plan-resources.server.ts. */
  energyRentalPriceSun: number;
  /** Rental duration requested from the energy rental provider when RENTED is active. */
  rentalDuration: RentalDuration;
  /** USD per TRX. Estimate — no live feed. Rescale all USD figures if this is wrong. */
  trxUsdPrice: number;
  /** Energy required for a transfer() to an address that already holds this token. Measured on Nile 2026-09-06 (n=50, zero variance). */
  energyExistingRecipient: number;
  /** Energy required for a transfer() to an address receiving this token for the first time. Measured on Nile 2026-09-06 (n=50, zero variance). */
  energyFreshRecipient: number;
  /** Bandwidth (net) required for a simple TRC20 transfer(). Measured on Nile 2026-09-06. */
  bandwidthPerTransfer: number;
  minPayoutMarginUsd: number;
  maxNetworkCostUsd: number;
  costGuardEnabled: boolean;
  provider: EnergyProviderKind;
};

export function economicsConfig(): EconomicsConfig {
  return {
    bandwidthPriceSun: num(process.env["BANDWIDTH_PRICE_SUN"], 1000),
    energyBurnPriceSun: num(process.env["ENERGY_BURN_PRICE_SUN"], 210),
    energyRentalPriceSun: num(process.env["ENERGY_RENTAL_PRICE_SUN"], 60),
    rentalDuration: rentalDuration(),
    trxUsdPrice: num(process.env["TRX_USD_PRICE"], 0.15),
    energyExistingRecipient: num(process.env["ENERGY_ESTIMATE_EXISTING"], 14650),
    energyFreshRecipient: num(process.env["ENERGY_ESTIMATE_FRESH"], 29650),
    bandwidthPerTransfer: num(process.env["BANDWIDTH_ESTIMATE"], 345),
    // Fail-safe default: require the payout to at least break even net of
    // network cost, rather than silently allowing a loss-making payout.
    minPayoutMarginUsd: num(process.env["MIN_PAYOUT_MARGIN_USD"], 0),
    // Fail-safe default: block anything with an anomalously large estimated
    // cost regardless of voucher size (catches config/measurement errors).
    maxNetworkCostUsd: num(process.env["MAX_NETWORK_COST_USD"], 1),
    // Fail-safe default: the guard is ON unless explicitly disabled.
    costGuardEnabled: bool(process.env["ENABLE_PAYOUT_COST_GUARD"], true),
    provider: activeEnergyProvider(),
  };
}
