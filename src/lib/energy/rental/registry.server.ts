import { resolveRuntime } from "@/lib/providers/registry.server";
import { MockEnergyRentalProvider } from "./mock-provider";
import { TronexEnergyRentalProvider } from "./tronex-provider.server";
import type { EnergyRentalProvider } from "./types";

/**
 * Every real TRON energy-rental marketplace (Tronex included) resells Energy
 * delegated FROM its own staked MAINNET accounts. That energy only exists on
 * TRON mainnet: Nile is an independent chain with its own separate resource
 * economy, not a mirror of mainnet accounts, so delegating mainnet energy to
 * a Nile address has zero effect on a Nile transaction. Meanwhile this app's
 * payout activation gate (resolveRuntime -> resolvePayoutProvider in
 * ../../providers/registry.server) only ever activates the real signer
 * (id "tron-testnet-signer") when TRON_NETWORK=NILE; anything else either
 * gets the simulated mock (CHAIN_MODE=DEMO/MAINNET, or TESTNET without
 * opting in) or UnavailablePayoutProvider, a non-simulated-but-always-throws
 * stand-in for a broken config (id "payout-signer-unavailable" -- verified in
 * registry-payout.test.ts). So "the real signer is active AND TRON_NETWORK
 * is MAINNET" can never both be true at once through this app's real
 * resolveRuntime(), and this function always returns the Mock provider today.
 *
 * The real TronexEnergyRentalProvider adapter is fully implemented and unit
 * tested against Tronex's documented API (see tronex-provider.server.ts) so
 * it's ready the day this app might target a real network Tronex actually
 * supports -- but it is intentionally unreachable from the current registry.
 */
export type RentalProviderDecision = "mock" | "real" | "missing-credentials";

/**
 * Pure decision logic, factored out so the fail-closed branch is directly
 * unit-testable: `resolveEnergyRentalProvider`'s own gate is unreachable
 * through this app's real `resolveRuntime()`, by design -- see the module
 * doc above.
 */
export function decideRentalProviderKind(input: {
  tronNetwork: string;
  /**
   * The active payout provider's `id`. Must be checked against the specific
   * real-signer id, NOT just `!simulated` -- a blocked/misconfigured signer
   * (UnavailablePayoutProvider, id "payout-signer-unavailable") also reports
   * `simulated: false` while never broadcasting anything, and must not be
   * treated as "a real marketplace purchase would matter here."
   */
  activePayoutProviderId: string;
  hasApiKey: boolean;
}): RentalProviderDecision {
  const wouldUseRealMarketplace =
    input.tronNetwork === "MAINNET" && input.activePayoutProviderId === "tron-testnet-signer";
  if (!wouldUseRealMarketplace) return "mock";
  return input.hasApiKey ? "real" : "missing-credentials";
}

export function resolveEnergyRentalProvider(): EnergyRentalProvider {
  const tronNetwork = (process.env["TRON_NETWORK"] ?? "").trim().toUpperCase();
  const runtime = resolveRuntime();
  const apiKey = process.env["TRONEX_API_KEY"];
  const decision = decideRentalProviderKind({
    tronNetwork,
    activePayoutProviderId: runtime.payoutProvider.id,
    hasApiKey: Boolean(apiKey),
  });

  if (decision === "mock") return new MockEnergyRentalProvider();
  if (decision === "missing-credentials") {
    // Fail closed: never silently substitute BURN pricing for a missing key.
    throw new Error(
      "ENERGY_RENTAL_UNAVAILABLE: TRONEX_API_KEY is not configured for a real-marketplace runtime.",
    );
  }
  return new TronexEnergyRentalProvider({
    apiKey: apiKey!,
    apiUrl: process.env["TRONEX_API_URL"] ?? "https://api.tronex.energy",
  });
}
