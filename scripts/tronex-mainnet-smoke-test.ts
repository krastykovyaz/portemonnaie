// Real Tronex Energy rental smoke test — TRON MAINNET, real TRX spend.
//
// THIS IS NOT A VOUCHER PAYOUT AND NEVER TOUCHES VOUCHERRAIL'S PAYOUT FLOW.
// It imports ONLY the standalone rental adapter + its own DB table:
//   - src/lib/energy/rental/tronex-provider.server.ts (the real Tronex adapter)
//   - src/lib/energy/rental/spending-ceiling.ts (hard USD spend cap)
//   - src/lib/energy/rental/verify-delegation.ts (independent-chain comparison)
//   - src/lib/db/procedures/energy-rentals.ts (persistence)
// It never imports registry.server.ts (payout activation gate), redemption.server.ts,
// payout.server.ts, or anything from src/lib/providers/. No voucher is read,
// no redemption is started, no signer is invoked, no USDT moves.
//
// SAFETY GATES (all required, no defaults, fails closed on any gap):
//   TRONEX_API_KEY              — a real, funded Tronex account key.
//   TRONEX_TEST_TARGET_ADDRESS  — a MAINNET address YOU control, already
//                                 active on-chain (Tronex refuses inactive
//                                 wallets). This is the delegation recipient
//                                 -- never derived, generated, or guessed by
//                                 this script.
//   TRONEX_TEST_MAX_COST_USD    — hard spending ceiling in USD. No default:
//                                 unset means "no one decided how much this
//                                 may spend," which fails closed.
//   TRONEX_TEST_CONFIRM         — must be exactly "I_UNDERSTAND_THIS_SPENDS_REAL_MONEY".
//                                 A plain env var, not a CLI flag, so it can't
//                                 be fat-fingered from shell history.
//
// This script does not read VoucherRail's CHAIN_MODE/TRON_NETWORK/PAYOUT_SIGNER
// at all -- Tronex operates independently of VoucherRail's own (Nile-only)
// payout signer, and this smoke test is intentionally isolated from it.

import { TronexEnergyRentalProvider } from "@/lib/energy/rental/tronex-provider.server";
import { checkSpendingCeiling } from "@/lib/energy/rental/spending-ceiling";
import { compareReportedVsObserved } from "@/lib/energy/rental/verify-delegation";
import {
  createPendingRental,
  markRentalActive,
  markRentalFailed,
} from "@/lib/db/procedures/energy-rentals";
import { economicsConfig } from "@/lib/energy/economics-config";

const TRON_MAINNET_API = process.env["TRON_MAINNET_API_URL"] ?? "https://api.trongrid.io";
// Smallest, cheapest unit Tronex sells, for the shortest duration -- see
// docs/energy-rental.md for where these limits come from (its OpenAPI spec).
const SMOKE_TEST_ENERGY = 65_000;
const SMOKE_TEST_DURATION = "1h" as const;

function fail(message: string): never {
  console.error(`ABORT: ${message}`);
  process.exit(1);
}

async function getAccountEnergy(address: string): Promise<number> {
  const res = await fetch(`${TRON_MAINNET_API}/wallet/getaccountresource`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, visible: true }),
  });
  if (!res.ok) throw new Error(`TronGrid getaccountresource failed: HTTP ${res.status}`);
  const body = (await res.json()) as { EnergyLimit?: number; EnergyUsed?: number };
  const limit = body.EnergyLimit ?? 0;
  const used = body.EnergyUsed ?? 0;
  return Math.max(0, limit - used);
}

async function main() {
  // --- Safety gates: every one fails closed, none has a silent default. ---
  const apiKey = process.env["TRONEX_API_KEY"];
  if (!apiKey) fail("TRONEX_API_KEY is not set. This must be a real, funded Tronex account key.");

  const targetAddress = process.env["TRONEX_TEST_TARGET_ADDRESS"];
  if (!targetAddress) {
    fail(
      "TRONEX_TEST_TARGET_ADDRESS is not set. No disposable/controlled MAINNET address exists in " +
        "this environment -- per instructions, STOP rather than improvise one. Set this to a real " +
        "MAINNET address you control and that is already active on-chain.",
    );
  }

  const confirm = process.env["TRONEX_TEST_CONFIRM"];
  if (confirm !== "I_UNDERSTAND_THIS_SPENDS_REAL_MONEY") {
    fail(
      'TRONEX_TEST_CONFIRM must be exactly "I_UNDERSTAND_THIS_SPENDS_REAL_MONEY" to run this script. ' +
        "This is a real MAINNET spend of real TRX.",
    );
  }

  console.log("Safety gates passed.");
  console.log("Target address:", targetAddress);
  console.log("TronGrid endpoint:", TRON_MAINNET_API);
  console.log("Requested energy:", SMOKE_TEST_ENERGY, "duration:", SMOKE_TEST_DURATION);

  const provider = new TronexEnergyRentalProvider({
    apiKey,
    apiUrl: process.env["TRONEX_API_URL"] ?? "https://api.tronex.energy",
  });

  // --- A. Real quote ---
  console.log("\n--- A. Requesting real quote ---");
  const quote = await provider.getQuote({
    targetAddress,
    requiredEnergy: SMOKE_TEST_ENERGY,
    duration: SMOKE_TEST_DURATION,
  });
  console.log("Quote:", JSON.stringify(quote, null, 2));

  const trxUsdPrice = economicsConfig().trxUsdPrice;
  const quotedUsd = quote.priceTrx * trxUsdPrice;
  console.log(`Quoted cost: ${quote.priceTrx} TRX (~$${quotedUsd.toFixed(4)} at illustrative $${trxUsdPrice}/TRX)`);

  // --- B. Spending ceiling check (hard fail-closed gate) ---
  const ceilingDecision = checkSpendingCeiling(quotedUsd, process.env["TRONEX_TEST_MAX_COST_USD"]);
  if (!ceilingDecision.ok) fail(ceilingDecision.reason);
  console.log(`Spending ceiling OK: $${quotedUsd.toFixed(4)} <= $${ceilingDecision.ceilingUsd}`);

  // --- Baseline: independent TronGrid read BEFORE any purchase ---
  console.log("\n--- Reading baseline Energy from TronGrid (before) ---");
  const energyBefore = await getAccountEnergy(targetAddress);
  console.log("Energy before:", energyBefore);

  // --- Persist a PENDING row before purchasing, exactly like production ---
  const idempotencyKey = process.env["TRONEX_TEST_RUN_ID"] ?? `mainnet-smoke-test:${Date.now()}`;
  const { rental } = createPendingRental({
    provider: provider.id,
    treasuryAddress: targetAddress,
    requestedEnergy: SMOKE_TEST_ENERGY,
    duration: SMOKE_TEST_DURATION,
    idempotencyKey,
  });
  console.log("Recorded PENDING rental row:", rental.id);

  // --- C. Create the real rental ---
  console.log("\n--- C. Purchasing real rental ---");
  let result;
  try {
    result = await provider.rentEnergy({
      targetAddress,
      energy: quote.quotedEnergy,
      duration: SMOKE_TEST_DURATION,
      idempotencyKey,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markRentalFailed(rental.id, message);
    fail(`Rental purchase failed: ${message}`);
  }
  console.log("Rental result:", JSON.stringify(result, null, 2));

  // --- D. Poll status until confirmed/failed/timeout ---
  console.log("\n--- D. Polling rental status ---");
  let verified = result;
  for (let attempt = 0; attempt < 5 && verified.status !== "ACTIVE" && verified.status !== "FAILED"; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await provider.getRentalStatus(result.rentalId);
    if (status) verified = status;
    console.log(`Poll ${attempt + 1}:`, verified.status);
  }

  if (verified.status !== "ACTIVE") {
    markRentalFailed(rental.id, `Never reached ACTIVE — last status: ${verified.status}`);
    fail(`Rental did not confirm within the poll window. Last status: ${verified.status}`);
  }

  // --- Independent TronGrid read AFTER the purchase confirmed ---
  console.log("\n--- Reading Energy from TronGrid (after) ---");
  const energyAfter = await getAccountEnergy(targetAddress);
  console.log("Energy after:", energyAfter);

  // --- E. Compare provider-reported vs chain-observed ---
  const comparison = compareReportedVsObserved({
    reportedDelegatedEnergy: verified.delegatedEnergy,
    observedEnergyBefore: energyBefore,
    observedEnergyAfter: energyAfter,
  });
  console.log("\n--- E. Comparison ---");
  console.log(JSON.stringify(comparison, null, 2));

  // --- Persist the confirmed rental ---
  const priceUsd = verified.priceTrx * trxUsdPrice;
  markRentalActive(rental.id, {
    providerOrderId: verified.rentalId,
    delegatedEnergy: verified.delegatedEnergy,
    priceTrx: verified.priceTrx,
    priceUsd,
    startedAt: result.startedAt,
    expiresAt: result.expiresAt,
    txHash: verified.txHash,
  });
  console.log("\nPersisted ACTIVE rental:", rental.id);

  console.log("\n=== SUMMARY ===");
  console.log("Quote:", quote);
  console.log("Actual rental cost (TRX):", verified.priceTrx, "(~$" + priceUsd.toFixed(4) + ")");
  console.log("Energy before:", energyBefore, "after:", energyAfter, "delta:", comparison.observedDelta);
  console.log("Reported delegated energy:", verified.delegatedEnergy);
  console.log("Discrepancy (reported - observed):", comparison.discrepancy, comparison.matches ? "(MATCH)" : "(MISMATCH)");
  console.log("Rental expires at:", result.expiresAt);
  console.log("Tx hash:", verified.txHash ?? "(none reported)");
  console.log(
    "\nTo verify release, re-run this script's getAccountEnergy check after",
    result.expiresAt,
    "and confirm Energy drops back toward the pre-rental baseline.",
  );
}

main().catch((error) => {
  console.error("UNEXPECTED ERROR:", error);
  process.exit(1);
});
