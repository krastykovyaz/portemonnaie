import type { BlockchainProvider } from "../providers/blockchain";
import { REQUIRED_CONFIRMATIONS, type PayoutStatus } from "./state-machine";

/**
 * Payout orchestrator — the single place that drives a payout through its
 * lifecycle. It is pure with respect to infrastructure: it only knows a
 * BlockchainProvider and a PayoutStore, so the exact same code path runs in
 * production (Supabase store), in the recovery worker, and in unit tests
 * (in-memory store).
 */

export type PayoutRecord = {
  id: string;
  redemptionId: string;
  voucherId: string;
  idempotencyKey: string;
  amount: number;
  token: string;
  network: string;
  destination: string;
  status: PayoutStatus;
  txHash: string | null;
  confirmations: number;
  attemptCount: number;
  maxAttempts: number;
  failureReason: string | null;
};

export interface PayoutStore {
  load(payoutId: string): Promise<PayoutRecord | null>;
  markBroadcast(payoutId: string, txHash: string, confirmations: number): Promise<void>;
  markConfirming(payoutId: string, confirmations: number): Promise<void>;
  confirm(payoutId: string, confirmations: number): Promise<{ ok: boolean; error?: string }>;
  fail(
    payoutId: string,
    reason: string,
    forceManual: boolean,
  ): Promise<{ ok: boolean; status: PayoutStatus }>;
}

export type PayoutLogger = (event: string, fields: Record<string, unknown>) => void;

export type DriveDeps = {
  provider: BlockchainProvider;
  store: PayoutStore;
  log?: PayoutLogger;
  sleep?: (ms: number) => Promise<void>;
  /** Confirmation polls per pass. The recovery worker continues what is left. */
  maxPolls?: number;
  pollDelayMs?: number;
};

export type PayoutOutcome = {
  payoutId: string;
  status: PayoutStatus;
  txHash: string | null;
  confirmations: number;
  failureReason: string | null;
  replayed?: boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function drivePayout(
  payout: PayoutRecord,
  deps: DriveDeps,
): Promise<PayoutOutcome> {
  const { provider, store } = deps;
  const log: PayoutLogger = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;
  const maxPolls = deps.maxPolls ?? 3;
  const pollDelayMs = deps.pollDelayMs ?? 150;

  const base = {
    payoutId: payout.id,
    redemptionId: payout.redemptionId,
    voucherId: payout.voucherId,
    idempotencyKey: payout.idempotencyKey,
  };

  if (payout.status === "CONFIRMED") {
    log("payout.already_confirmed", base);
    return {
      payoutId: payout.id,
      status: "CONFIRMED",
      txHash: payout.txHash,
      confirmations: payout.confirmations,
      failureReason: null,
      replayed: true,
    };
  }

  if (payout.status === "MANUAL_REVIEW") {
    log("payout.manual_review_skipped", base);
    return {
      payoutId: payout.id,
      status: "MANUAL_REVIEW",
      txHash: payout.txHash,
      confirmations: payout.confirmations,
      failureReason: payout.failureReason,
    };
  }

  let txHash = payout.txHash;
  let attempt = payout.attemptCount;

  // 1. Reconcile an existing broadcast before ever sending a second one.
  if (txHash) {
    const onChain = await provider.getTransactionStatus(txHash);
    if (onChain === null) {
      log("payout.tx_unknown_to_provider", { ...base, txHash });
      txHash = null; // re-broadcast below, using the same idempotency key
    } else if (onChain.status === "FAILED") {
      const escalate = attempt + 1 >= payout.maxAttempts;
      const result = await store.fail(payout.id, "PROVIDER_REPORTED_FAILED", escalate);
      log("payout.failed", { ...base, txHash, status: result.status });
      return {
        payoutId: payout.id,
        status: result.status,
        txHash,
        confirmations: onChain.confirmations,
        failureReason: "PROVIDER_REPORTED_FAILED",
      };
    }
  }

  // 2. Broadcast (idempotent at the provider level).
  if (!txHash) {
    if (attempt >= payout.maxAttempts) {
      const result = await store.fail(payout.id, "MAX_ATTEMPTS_EXHAUSTED", true);
      log("payout.escalated", { ...base, status: result.status });
      return {
        payoutId: payout.id,
        status: result.status,
        txHash: null,
        confirmations: 0,
        failureReason: "MAX_ATTEMPTS_EXHAUSTED",
      };
    }
    try {
      const tx = await provider.createPayout({
        idempotencyKey: payout.idempotencyKey,
        amount: payout.amount,
        asset: payout.token,
        network: payout.network,
        destinationAddress: payout.destination,
        reference: payout.redemptionId,
      });
      txHash = tx.txHash;
      attempt += 1;
      await store.markBroadcast(payout.id, tx.txHash, tx.confirmations);
      log("payout.broadcast", {
        ...base,
        txHash,
        attempt,
        deduplicated: Boolean(tx.deduplicated),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "BROADCAST_FAILED";
      const escalate = attempt + 1 >= payout.maxAttempts;
      const result = await store.fail(payout.id, reason, escalate);
      log("payout.broadcast_failed", { ...base, reason, status: result.status });
      return {
        payoutId: payout.id,
        status: result.status,
        txHash: null,
        confirmations: 0,
        failureReason: reason,
      };
    }
  }

  // 3. Confirmations. Never finalize the voucher before CONFIRMED.
  let confirmations = payout.confirmations;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    confirmations = await provider.getConfirmations(txHash);
    if (confirmations >= REQUIRED_CONFIRMATIONS) {
      const confirmed = await store.confirm(payout.id, confirmations);
      if (!confirmed.ok) {
        log("payout.confirm_rejected", { ...base, txHash, error: confirmed.error });
        const result = await store.fail(payout.id, confirmed.error ?? "CONFIRM_REJECTED", true);
        return {
          payoutId: payout.id,
          status: result.status,
          txHash,
          confirmations,
          failureReason: confirmed.error ?? "CONFIRM_REJECTED",
        };
      }
      log("payout.confirmed", { ...base, txHash, confirmations });
      return {
        payoutId: payout.id,
        status: "CONFIRMED",
        txHash,
        confirmations,
        failureReason: null,
      };
    }
    await store.markConfirming(payout.id, confirmations);
    if (poll < maxPolls - 1) await sleep(pollDelayMs);
  }

  log("payout.left_confirming", { ...base, txHash, confirmations });
  return {
    payoutId: payout.id,
    status: "CONFIRMING",
    txHash,
    confirmations,
    failureReason: null,
  };
}
