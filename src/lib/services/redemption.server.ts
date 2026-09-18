import { db, nowIso } from "@/lib/db/client";
import {
  voucherPreview as voucherPreviewProc,
  startRedemption,
  failRedemption,
} from "@/lib/db/procedures/redemption";
import { createPayoutForRedemption, payoutManualReview } from "@/lib/db/procedures/payouts";
import { FEE_RATE, type RedemptionResult } from "../domain/types";
import { hashVoucherCode } from "../voucher-codes";
import { blockchainProvider } from "../providers/mock-blockchain";
import { resolveRuntime } from "../providers/registry.server";
import { screeningProvider } from "../providers/compliance";
import { drivePayout } from "../payout/orchestrator";
import { supabasePayoutStore } from "./payout-store.server";
import { payoutLog } from "./payout.server";
import { assessPayoutResources } from "../energy/pre-broadcast-guard.server";

export type PreviewResult =
  | {
      ok: true;
      public_id: string;
      asset: string;
      network: string;
      denomination: number;
      expires_at: string;
    }
  | { ok: false; error: string; status?: string };

const ERROR_COPY: Record<string, string> = {
  NOT_FOUND: "We could not find that voucher. Check the voucher link and code.",
  INVALID_CODE: "That voucher code is not valid for this voucher.",
  EXPIRED: "This voucher has expired and can no longer be redeemed.",
  INVALID_STATUS: "This voucher is not available for redemption.",
  ALREADY_IN_PROGRESS: "This voucher is already being redeemed.",
  INVALID_ADDRESS: "That does not look like a valid TRON testnet address.",
};

export function explainError(code: string, status?: string): string {
  if (code === "INVALID_STATUS" && status) {
    if (status === "REDEEMED") return "This voucher has already been redeemed.";
    if (status === "BLOCKED") return "This voucher has been blocked. Contact support.";
    if (status === "CANCELLED") return "This voucher has been cancelled.";
    if (status === "REDEEMING") return "This voucher is already being redeemed.";
    return "This voucher has not been sold yet, so it cannot be redeemed.";
  }
  return ERROR_COPY[code] ?? "Redemption failed. Please try again.";
}

export async function previewVoucher(publicId: string, code: string): Promise<PreviewResult> {
  return voucherPreviewProc(publicId, await hashVoucherCode(code));
}

export function validateDestinationAddress(address: string): boolean {
  return blockchainProvider.validateAddress(address);
}

export async function redeemVoucher(input: {
  publicId: string;
  code: string;
  destination: string;
  userId?: string | null;
}): Promise<{ ok: true; result: RedemptionResult } | { ok: false; error: string }> {
  const destination = input.destination.trim();
  if (!blockchainProvider.validateAddress(destination)) {
    return { ok: false, error: explainError("INVALID_ADDRESS") };
  }

  // Compliance seam: mock screening never approves or bypasses anything.
  await screeningProvider.screenAddress(destination);

  const start = startRedemption({
    publicId: input.publicId,
    codeHash: await hashVoucherCode(input.code),
    destination,
    userId: input.userId ?? null,
  });

  if (!start.ok) return { ok: false, error: explainError(start.error, start.status) };

  // DEMO / un-opted-in TESTNET -> mock (simulated payouts, unchanged behavior).
  // CHAIN_MODE=TESTNET + PAYOUT_SIGNER=TRON_TESTNET (validated) -> the real signer.
  // MAINNET always gets the mock here — real payouts are entirely out of scope.
  const runtime = resolveRuntime();

  // Cost estimation + guard: real payouts only. Simulated payouts have no
  // real chain to query and no real cost, so this is skipped entirely for
  // them — zero behavior change for DEMO/un-opted-in TESTNET.
  let recipientKind: "fresh" | "existing" | null = null;
  let estimatedEnergy: number | null = null;
  let estimatedBandwidth: number | null = null;
  let resourceSource: string | null = null;
  let energyRentalId: string | null = null;
  if (!runtime.payoutProvider.simulated) {
    // Same guard the recovery sweep and admin retry run before they broadcast
    // (see pre-broadcast-guard.server.ts). With ENERGY_PROVIDER=RENTED and a
    // real shortfall it quotes, guard-checks the REAL price, and purchases a
    // rental; otherwise it's the plain BURN/STAKED guard decision.
    const assessment = await assessPayoutResources({
      destination,
      amount: Number(start.amount),
      idempotencyKey: start.redemption_id,
    });

    recipientKind = assessment.recipientKind;
    estimatedEnergy = assessment.estimatedEnergy;
    estimatedBandwidth = assessment.estimatedBandwidth;
    resourceSource = assessment.resourceSource;
    energyRentalId = assessment.ok ? assessment.rentalId : null;

    if (!assessment.ok) {
      const payoutId = createPayoutForRedemption({
        redemptionId: start.redemption_id,
        voucherId: start.voucher_id,
        transactionId: start.transaction_id,
        userId: input.userId ?? null,
        amount: Number(start.amount),
        network: start.network,
        token: start.asset,
        destination,
        idempotencyKey: start.redemption_id,
        provider: runtime.payoutProvider.id,
        recipientKind,
        estimatedEnergy,
        estimatedBandwidth,
        resourceSource,
      });
      // Terminal until an admin acts (same MANUAL_REVIEW semantics as any
      // other payout escalation) — the voucher deliberately stays REDEEMING,
      // not released, exactly like the orchestrator-driven MANUAL_REVIEW
      // path below, so it can't be redeemed twice while under review.
      payoutManualReview({
        payoutId,
        reason: assessment.reason,
        actorId: input.userId ?? null,
        actorLabel: "cost-guard",
      });
      return {
        ok: false,
        error: "This payout requires manual review before it can be sent — please contact support.",
      };
    }
  }

  const payoutId = createPayoutForRedemption({
    redemptionId: start.redemption_id,
    voucherId: start.voucher_id,
    transactionId: start.transaction_id,
    userId: input.userId ?? null,
    amount: Number(start.amount),
    network: start.network,
    token: start.asset,
    destination,
    // Stable per redemption, reused on every retry of this same voucher's
    // payout -- this is what lets the orchestrator (and the real signer's
    // own crash-safe broadcast table) recognize a retry instead of ever
    // creating a second on-chain transfer for one redemption.
    idempotencyKey: start.redemption_id,
    provider: runtime.payoutProvider.id,
    recipientKind,
    estimatedEnergy,
    estimatedBandwidth,
    resourceSource,
    energyRentalId,
  });

  const record = await supabasePayoutStore.load(payoutId);
  if (!record) {
    failRedemption(start.redemption_id, "PAYOUT_RECORD_MISSING");
    return { ok: false, error: "Redemption failed. Please try again." };
  }

  let outcome;
  try {
    outcome = await drivePayout(record, {
      provider: runtime.payoutProvider,
      store: supabasePayoutStore,
      log: payoutLog,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "PAYOUT_FAILED";
    failRedemption(start.redemption_id, message);
    return {
      ok: false,
      error: runtime.payoutProvider.simulated
        ? "The simulated payout failed. The voucher was released — try again."
        : "The payout could not be processed. Please try again shortly.",
    };
  }

  if (outcome.status === "CONFIRMED") {
    // drivePayout -> store.confirm() (payoutConfirm) already finalized the
    // redemption: ledger posted, voucher marked REDEEMED. Read back the
    // settled numbers rather than recomputing/re-writing them here.
    const payoutRow = db
      .query(`SELECT amount, fee_rate, confirmed_at FROM payouts WHERE id = ?`)
      .get(payoutId) as { amount: number; fee_rate: number; confirmed_at: string | null } | null;
    const amount = Number(payoutRow?.amount ?? start.amount);
    const feeRate = Number(payoutRow?.fee_rate ?? FEE_RATE);
    const fee = Math.round(amount * feeRate * 100) / 100;
    return {
      ok: true,
      result: {
        public_id: input.publicId,
        amount,
        asset: start.asset,
        network: start.network,
        destination,
        tx_hash: outcome.txHash ?? "",
        confirmations: outcome.confirmations,
        confirmed_at: payoutRow?.confirmed_at ?? nowIso(),
        fee,
        simulated: runtime.payoutProvider.simulated,
      },
    };
  }

  if (outcome.status === "FAILED" || outcome.status === "MANUAL_REVIEW") {
    // payoutFail() already marked the payout + transaction FAILED. The
    // voucher deliberately stays REDEEMING (not released back to SOLD) so a
    // retry reuses this same payout/idempotency key instead of racing a
    // second redemption attempt against it — see payouts.ts.
    return {
      ok: false,
      error:
        outcome.status === "MANUAL_REVIEW"
          ? "This payout needs manual review. Please contact support with your voucher ID."
          : "The payout could not be completed. It will be retried automatically.",
    };
  }

  // BROADCAST / CONFIRMING: genuinely in flight on a real chain. Never claim
  // success before REQUIRED_CONFIRMATIONS is actually reached — the recovery
  // sweep finishes this and finalizes the redemption once it does.
  return {
    ok: false,
    error:
      "Your payout has been broadcast and is waiting for confirmations. This can take a moment — check back shortly.",
  };
}
