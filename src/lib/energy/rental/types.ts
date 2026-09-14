/**
 * Provider-agnostic TRON Energy rental abstraction. `EnergyManager`/payout
 * code never talks to a specific marketplace directly -- only through this
 * interface, resolved via ./registry.server. See tronex-provider.server.ts
 * for the one real adapter implemented so far, and mock-provider.ts for the
 * deterministic double used in every runtime this app can actually reach
 * (Nile) and in tests.
 */

export type EnergyRentalDuration = "1h" | "1d" | "3d" | "7d";

export type RentalQuoteRequest = {
  targetAddress: string;
  /** Energy this payout is short by -- not the account's total requirement. */
  requiredEnergy: number;
  duration: EnergyRentalDuration;
};

export type RentalQuote = {
  provider: string;
  requiredEnergy: number;
  /** Energy the provider would actually deliver -- rounded up to its minimum sellable unit. */
  quotedEnergy: number;
  duration: EnergyRentalDuration;
  priceTrx: number;
  currency: "TRX";
};

export type RentalRequest = {
  targetAddress: string;
  energy: number;
  duration: EnergyRentalDuration;
  /** Caller-supplied idempotency key. A retry with the same key must never buy a second rental. */
  idempotencyKey: string;
};

export type RentalStatus = "PENDING" | "ACTIVE" | "FAILED" | "EXPIRED" | "CANCELLED";

export type RentalResult = {
  /** Identifier this provider understands -- pass back into getRentalStatus/cancelRental as-is. */
  rentalId: string;
  provider: string;
  targetAddress: string;
  delegatedEnergy: number;
  priceTrx: number;
  currency: "TRX";
  startedAt: string;
  expiresAt: string;
  status: RentalStatus;
  txHash: string | null;
};

export interface EnergyRentalProvider {
  readonly id: string;
  getQuote(request: RentalQuoteRequest): Promise<RentalQuote>;
  rentEnergy(request: RentalRequest): Promise<RentalResult>;
  getRentalStatus(rentalId: string): Promise<RentalResult | null>;
  /** Optional -- omit entirely when the underlying marketplace has no cancellation/refund path. */
  cancelRental?(rentalId: string): Promise<{ ok: boolean; reason?: string }>;
}
