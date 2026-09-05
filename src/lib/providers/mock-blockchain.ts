import type {
  BlockchainProvider,
  ChainTransaction,
  ChainTxStatus,
  PayoutRequest,
} from "./blockchain";

const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * Deterministic demo scenarios. The scenario is derived from the LAST character
 * of the destination address so QA can reproduce every failure mode without any
 * hidden switches:
 *   ...F  -> broadcast fails immediately
 *   ...S  -> slow broadcast (extra latency), then confirms
 *   ...T  -> stalls in CONFIRMING; only the recovery worker finishes it
 *   ...X  -> transaction is "lost" by the provider after broadcast
 *   else  -> success
 */
export type MockScenario = "SUCCESS" | "FAIL" | "SLOW" | "TIMEOUT" | "LOST";

export function scenarioForAddress(address: string): MockScenario {
  const last = address.trim().slice(-1).toUpperCase();
  if (last === "F") return "FAIL";
  if (last === "S") return "SLOW";
  if (last === "T") return "TIMEOUT";
  if (last === "X") return "LOST";
  return "SUCCESS";
}

type MockTx = ChainTransaction & { scenario: MockScenario; polls: number };

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * MockBlockchainProvider — simulates TRON testnet USDT payouts.
 * No keys, no signing, no network calls, no real value. DEMO ONLY.
 */
export class MockBlockchainProvider implements BlockchainProvider {
  readonly id = "mock-tron-testnet";
  readonly network = "TRON_TESTNET";
  readonly simulated = true;

  private byHash = new Map<string, MockTx>();
  private byKey = new Map<string, string>();

  /** Test hook: simulate a provider/server restart losing in-flight state. */
  reset(): void {
    this.byHash.clear();
    this.byKey.clear();
  }

  validateAddress(address: string): boolean {
    return TRON_ADDRESS_RE.test(address.trim());
  }

  async getBalance(asset: string): Promise<number> {
    return asset === "USDT" ? 250_000 : 0;
  }

  async createPayout(request: PayoutRequest): Promise<ChainTransaction> {
    const destination = request.destinationAddress.trim();
    if (!this.validateAddress(destination)) throw new Error("INVALID_ADDRESS");
    if (request.amount <= 0) throw new Error("INVALID_AMOUNT");

    // Idempotency: the same key never produces a second transaction.
    const existingHash = this.byKey.get(request.idempotencyKey);
    if (existingHash) {
      const existing = this.byHash.get(existingHash);
      if (existing) return { ...existing, deduplicated: true };
    }

    const scenario = scenarioForAddress(destination);
    if (scenario === "SLOW") await sleep(400);

    if (scenario === "FAIL") {
      throw new Error("PROVIDER_REJECTED: simulated broadcast failure");
    }

    const tx: MockTx = {
      txHash: randomHex(32),
      status: "BROADCAST",
      confirmations: 0,
      amount: request.amount,
      asset: request.asset,
      network: this.network,
      destinationAddress: destination,
      createdAt: new Date().toISOString(),
      scenario,
      polls: 0,
    };
    this.byHash.set(tx.txHash, tx);
    this.byKey.set(request.idempotencyKey, tx.txHash);
    return { ...tx };
  }

  async getTransactionStatus(txHash: string): Promise<ChainTransaction | null> {
    const tx = this.byHash.get(txHash);
    if (!tx) return null;
    if (tx.scenario === "LOST") {
      // Provider forgets the transaction once, forcing a reconciliation path.
      this.byHash.delete(txHash);
      return null;
    }
    return { ...tx };
  }

  async getConfirmations(txHash: string): Promise<number> {
    const tx = this.byHash.get(txHash);
    if (!tx) return 0;
    tx.polls += 1;
    // TIMEOUT confirms very slowly so the first pass leaves it CONFIRMING.
    const step = tx.scenario === "TIMEOUT" ? 1 : 3;
    tx.confirmations = Math.min(20, tx.confirmations + step);
    const status: ChainTxStatus = tx.confirmations >= 3 ? "CONFIRMED" : "CONFIRMING";
    tx.status = status;
    this.byHash.set(txHash, tx);
    return tx.confirmations;
  }
}

export const blockchainProvider: BlockchainProvider = new MockBlockchainProvider();
