import type {
  EnergyRentalDuration,
  EnergyRentalProvider,
  RentalQuote,
  RentalQuoteRequest,
  RentalRequest,
  RentalResult,
} from "./types";

const DURATION_MS: Record<EnergyRentalDuration, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** Tronex's real documented minimum sellable unit -- mirrored here so the mock's rounding behavior matches the real adapter. */
const PROVIDER_MIN_ENERGY = 65_000;

export type MockRentalOptions = {
  /** TRX per unit of energy. Default is a rough real-world market rate, not a live feed. */
  pricePerEnergyTrx?: number;
  shouldFailQuote?: boolean;
  shouldFailRental?: boolean;
  /** getRentalStatus never reports ACTIVE -- simulates a delegation that never confirms (timeout). */
  neverConfirms?: boolean;
};

/**
 * Deterministic double for tests AND for this app's only reachable runtime
 * (Nile). No network calls, no real TRX. See registry.server.ts for why the
 * real TronexEnergyRentalProvider is never selected while TRON_NETWORK=NILE.
 */
export class MockEnergyRentalProvider implements EnergyRentalProvider {
  readonly id = "mock-energy-rental";
  quoteCalls = 0;
  rentCalls = 0;

  private rentals = new Map<string, RentalResult>();
  private byIdempotencyKey = new Map<string, string>();

  constructor(private opts: MockRentalOptions = {}) {}

  async getQuote(request: RentalQuoteRequest): Promise<RentalQuote> {
    this.quoteCalls += 1;
    if (this.opts.shouldFailQuote) throw new Error("MOCK_QUOTE_UNAVAILABLE");
    const quotedEnergy = Math.max(request.requiredEnergy, PROVIDER_MIN_ENERGY);
    const perEnergy = this.opts.pricePerEnergyTrx ?? 0.00015;
    return {
      provider: this.id,
      requiredEnergy: request.requiredEnergy,
      quotedEnergy,
      duration: request.duration,
      priceTrx: Math.round(quotedEnergy * perEnergy * 1_000_000) / 1_000_000,
      currency: "TRX",
    };
  }

  async rentEnergy(request: RentalRequest): Promise<RentalResult> {
    this.rentCalls += 1;
    const existingId = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existingId) return this.rentals.get(existingId)!;

    if (this.opts.shouldFailRental) throw new Error("MOCK_RENTAL_FAILED");

    const now = new Date();
    const perEnergy = this.opts.pricePerEnergyTrx ?? 0.00015;
    const rentalId = `mock_${request.idempotencyKey}`;
    const result: RentalResult = {
      rentalId,
      provider: this.id,
      targetAddress: request.targetAddress,
      delegatedEnergy: request.energy,
      priceTrx: Math.round(request.energy * perEnergy * 1_000_000) / 1_000_000,
      currency: "TRX",
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DURATION_MS[request.duration]).toISOString(),
      status: this.opts.neverConfirms ? "PENDING" : "ACTIVE",
      txHash: this.opts.neverConfirms ? null : `mock_tx_${this.rentCalls}`,
    };
    this.rentals.set(rentalId, result);
    this.byIdempotencyKey.set(request.idempotencyKey, rentalId);
    return result;
  }

  async getRentalStatus(rentalId: string): Promise<RentalResult | null> {
    return this.rentals.get(rentalId) ?? null;
  }
}
