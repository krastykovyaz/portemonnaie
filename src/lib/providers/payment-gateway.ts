/**
 * PaymentGateway — the *inbound* side of the chain abstraction.
 *
 * Everything the order flow knows about receiving USDT lives behind this
 * interface, so a mock chain, a TRON testnet node and a mainnet node are
 * interchangeable. Implementations are read-only: they never sign or move funds.
 */
import type { ChainMode } from "../config/mode";

export type IncomingTransfer = {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: number;
  asset: string;
  confirmations: number;
  blockNumber: number | null;
  observedAt: string;
};

export type DepositAddress = {
  address: string;
  network: string;
  asset: string;
  contractAddress: string | null;
  /** Human note shown to the customer, e.g. "send exactly 50 USDT (TRC-20)". */
  memo: string | null;
};

export interface PaymentGateway {
  readonly id: string;
  readonly mode: ChainMode;
  readonly network: string;
  readonly asset: string;
  readonly contractAddress: string | null;
  readonly simulated: boolean;
  validateAddress(address: string): boolean;
  /** Deposit address for an order reference. May be shared (amount+memo matched). */
  getDepositAddress(orderRef: string): Promise<DepositAddress>;
  /** All USDT transfers seen for the address, newest first. */
  getIncomingTransfers(address: string): Promise<IncomingTransfer[]>;
  getConfirmations(txHash: string): Promise<number>;
  getBalance(address: string): Promise<number>;
}
