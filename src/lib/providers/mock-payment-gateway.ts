import type { ChainMode } from "../config/mode";
import type { DepositAddress, IncomingTransfer, PaymentGateway } from "./payment-gateway";

const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** Deterministic pseudo-TRON address derived from a seed — DEMO only. */
export function mockAddressFor(seed: string): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  let out = "T";
  for (let i = 0; i < 33; i += 1) {
    hash ^= hash << 13;
    hash = (hash ^ (hash >>> 17)) >>> 0;
    hash = (hash ^ (hash << 5)) >>> 0;
    out += alphabet[hash % alphabet.length];
  }
  return out;
}

type MockTransfer = IncomingTransfer & { targetConfirmations: number };

/**
 * In-memory simulated inbound gateway. Transfers only exist once something
 * explicitly simulates them (admin demo tools or the test suite), so the demo
 * never invents money on its own.
 */
export class MockPaymentGateway implements PaymentGateway {
  readonly id = "mock-payment-gateway";
  readonly mode: ChainMode = "DEMO";
  readonly network = "MOCK_CHAIN";
  readonly asset = "USDT";
  readonly contractAddress = null;
  readonly simulated = true;

  private byAddress = new Map<string, MockTransfer[]>();
  private byHash = new Map<string, MockTransfer>();

  reset(): void {
    this.byAddress.clear();
    this.byHash.clear();
  }

  validateAddress(address: string): boolean {
    return TRON_ADDRESS_RE.test(address.trim());
  }

  async getDepositAddress(orderRef: string): Promise<DepositAddress> {
    return {
      address: mockAddressFor(`deposit:${orderRef}`),
      network: this.network,
      asset: this.asset,
      contractAddress: null,
      memo: `Simulated deposit address for ${orderRef}`,
    };
  }

  /** Test/demo hook: pretend a customer sent USDT to a deposit address. */
  simulateTransfer(input: {
    toAddress: string;
    amount: number;
    txHash?: string;
    confirmations?: number;
    targetConfirmations?: number;
    fromAddress?: string;
  }): IncomingTransfer {
    const transfer: MockTransfer = {
      txHash: input.txHash ?? `mock_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
      fromAddress: input.fromAddress ?? mockAddressFor(`customer:${input.toAddress}`),
      toAddress: input.toAddress,
      amount: input.amount,
      asset: this.asset,
      confirmations: input.confirmations ?? 0,
      blockNumber: Math.floor(Date.now() / 1000),
      observedAt: new Date().toISOString(),
      targetConfirmations: input.targetConfirmations ?? 3,
    };
    const list = this.byAddress.get(input.toAddress) ?? [];
    list.unshift(transfer);
    this.byAddress.set(input.toAddress, list);
    this.byHash.set(transfer.txHash, transfer);
    return { ...transfer };
  }

  async getIncomingTransfers(address: string): Promise<IncomingTransfer[]> {
    return (this.byAddress.get(address) ?? []).map((t) => ({ ...t }));
  }

  async getConfirmations(txHash: string): Promise<number> {
    const tx = this.byHash.get(txHash);
    if (!tx) return 0;
    tx.confirmations = Math.min(tx.targetConfirmations, tx.confirmations + 1);
    return tx.confirmations;
  }

  async getBalance(address: string): Promise<number> {
    const list = this.byAddress.get(address) ?? [];
    return list.reduce((sum, t) => sum + t.amount, 0);
  }
}

export const mockPaymentGateway = new MockPaymentGateway();
