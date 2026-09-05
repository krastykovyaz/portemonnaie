import type { BlockchainProvider, ChainTransaction, PayoutRequest } from "./blockchain";

/**
 * Used ONLY when PAYOUT_SIGNER=TRON_TESTNET was explicitly requested but
 * configuration validation failed. Never falls back to a simulated payout —
 * every call fails loudly with the exact reasons, so a broken config shows up
 * as a failed/manual-review payout instead of a quietly-simulated one.
 */
export class UnavailablePayoutProvider implements BlockchainProvider {
  readonly id = "payout-signer-unavailable";
  readonly network = "TRON_TESTNET";
  readonly simulated = false;

  constructor(private readonly reasons: string[]) {}

  private fail(): never {
    throw new Error(`PAYOUT_SIGNER_UNAVAILABLE: ${this.reasons.join("; ")}`);
  }

  validateAddress(): boolean {
    return false;
  }

  async getBalance(): Promise<number> {
    this.fail();
  }

  async createPayout(_request: PayoutRequest): Promise<ChainTransaction> {
    this.fail();
  }

  async getTransactionStatus(): Promise<ChainTransaction | null> {
    this.fail();
  }

  async getConfirmations(): Promise<number> {
    this.fail();
  }
}
