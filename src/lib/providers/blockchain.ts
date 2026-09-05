/**
 * BlockchainProvider abstraction.
 *
 * All payout logic talks ONLY to this interface, so the MockBlockchainProvider
 * used by this DEMO can later be replaced by a real Tron/USDT RPC node or a
 * regulated custody/CASP provider without touching the voucher, payout or
 * ledger logic.
 */

export type ChainTxStatus = "PENDING" | "BROADCAST" | "CONFIRMING" | "CONFIRMED" | "FAILED";

export type PayoutRequest = {
  /** Stable key — the provider MUST return the same transaction for a repeated key. */
  idempotencyKey: string;
  amount: number;
  asset: string;
  network: string;
  destinationAddress: string;
  reference: string;
};

export type ChainTransaction = {
  txHash: string;
  status: ChainTxStatus;
  confirmations: number;
  amount: number;
  asset: string;
  network: string;
  destinationAddress: string;
  createdAt: string;
  /** True when a repeated idempotency key returned an existing transaction. */
  deduplicated?: boolean;
  failureReason?: string;
};

export interface BlockchainProvider {
  readonly id: string;
  readonly network: string;
  readonly simulated: boolean;
  validateAddress(address: string): boolean;
  getBalance(asset: string): Promise<number>;
  createPayout(request: PayoutRequest): Promise<ChainTransaction>;
  /** Returns null when the provider has no record of the hash (lost transaction). */
  getTransactionStatus(txHash: string): Promise<ChainTransaction | null>;
  getConfirmations(txHash: string): Promise<number>;
}
