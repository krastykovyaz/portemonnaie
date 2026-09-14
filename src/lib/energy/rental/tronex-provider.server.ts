import type {
  EnergyRentalDuration,
  EnergyRentalProvider,
  RentalQuote,
  RentalQuoteRequest,
  RentalRequest,
  RentalResult,
} from "./types";

/**
 * Real adapter for Tronex Energy (https://tronxenergy.com), a TRON mainnet
 * energy-rental marketplace. Verified directly against its published OpenAPI
 * 3.0.3 spec at https://api.tronex.energy/api/v1/openapi.json (fetched and
 * inspected 2026-09-07) -- every field name and endpoint below is taken
 * verbatim from that spec, not guessed.
 *
 * MAINNET-ONLY, by construction of the marketplace itself: Tronex resells
 * Energy delegated from its own staked TRON MAINNET accounts. That energy has
 * no effect on Nile, which is an independent chain with its own separate
 * resource economy -- delegating mainnet energy to a Nile address does
 * nothing for a Nile transaction. The spec has no mention of testnet/Nile
 * anywhere. See ../rental/registry.server.ts for why this class is
 * constructed only in a hypothetical MAINNET runtime this app's own payout
 * activation gate never actually reaches.
 *
 * Confirmed from the spec:
 * - Auth: `X-API-KEY` header on every request (optional HMAC add-on exists
 *   but requires contacting Tronex support to enable -- not used here).
 * - POST /api/v1/precountOrder { days, volume } -> { duration, volume, price, summa }
 * - POST /api/v1/buyenergy { days, volume, target } -> { ..., order_id, status: Filled|Pending|Cancelled, txid }
 * - GET  /api/v1/status/{id} -> same shape as buyenergy's response (id = order_id)
 * - Energy volume: 65,000 (min) - 2,000,000 (max) per order.
 * - Duration enum: "1h" | "1d" | "3d" | "7d".
 * - No cancellation/refund endpoint exists anywhere in the spec -- cancelRental
 *   is intentionally NOT implemented (left undefined), not stubbed to a fake
 *   success.
 * - No idempotency-key field in any request schema -- Tronex does not
 *   de-duplicate on our behalf. All idempotency protection is ours, enforced
 *   at the DB layer (energy_rentals.idempotency_key UNIQUE) one level up in
 *   ../rental/plan-resources.server.ts, never inside this adapter.
 */

const MIN_ENERGY = 65_000;
const MAX_ENERGY = 2_000_000;

type TronexOrderResponse = {
  days?: EnergyRentalDuration;
  duration?: EnergyRentalDuration;
  volume: number;
  price: number;
  summa: number;
  target?: string;
  order_id: number;
  status: "Filled" | "Pending" | "Cancelled";
  txid: string | null;
};

function clampVolume(energy: number): number {
  return Math.min(MAX_ENERGY, Math.max(MIN_ENERGY, Math.ceil(energy)));
}

function toRentalStatus(status: TronexOrderResponse["status"]): RentalResult["status"] {
  if (status === "Filled") return "ACTIVE";
  if (status === "Cancelled") return "FAILED";
  return "PENDING";
}

export class TronexEnergyRentalProvider implements EnergyRentalProvider {
  readonly id = "tronex-energy";

  constructor(private readonly opts: { apiKey: string; apiUrl: string }) {}

  private headers(): Record<string, string> {
    // Never log this object -- it carries the live API key.
    return { "content-type": "application/json", "X-API-KEY": this.opts.apiKey };
  }

  async getQuote(request: RentalQuoteRequest): Promise<RentalQuote> {
    const volume = clampVolume(request.requiredEnergy);
    const res = await fetch(`${this.opts.apiUrl}/api/v1/precountOrder`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ days: request.duration, volume }),
    });
    if (!res.ok) {
      throw new Error(`TRONEX_QUOTE_FAILED: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { duration: EnergyRentalDuration; volume: number; summa: number };
    return {
      provider: this.id,
      requiredEnergy: request.requiredEnergy,
      quotedEnergy: body.volume,
      duration: body.duration,
      priceTrx: body.summa,
      currency: "TRX",
    };
  }

  async rentEnergy(request: RentalRequest): Promise<RentalResult> {
    const volume = clampVolume(request.energy);
    const res = await fetch(`${this.opts.apiUrl}/api/v1/buyenergy`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ days: request.duration, volume, target: request.targetAddress }),
    });
    if (!res.ok) {
      throw new Error(`TRONEX_RENTAL_FAILED: HTTP ${res.status}`);
    }
    const body = (await res.json()) as TronexOrderResponse;
    const now = new Date().toISOString();
    return {
      // Tronex's order_id is the only handle getRentalStatus can use.
      rentalId: String(body.order_id),
      provider: this.id,
      targetAddress: body.target ?? request.targetAddress,
      delegatedEnergy: body.volume,
      priceTrx: body.summa,
      currency: "TRX",
      startedAt: now,
      // Tronex's response has no expiry field -- derived from the requested
      // duration, applied from the moment the order was accepted.
      expiresAt: addDuration(now, request.duration),
      status: toRentalStatus(body.status),
      txHash: body.txid,
    };
  }

  async getRentalStatus(rentalId: string): Promise<RentalResult | null> {
    const res = await fetch(`${this.opts.apiUrl}/api/v1/status/${rentalId}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`TRONEX_STATUS_FAILED: HTTP ${res.status}`);
    }
    const body = (await res.json()) as TronexOrderResponse;
    return {
      rentalId: String(body.order_id),
      provider: this.id,
      targetAddress: body.target ?? "",
      delegatedEnergy: body.volume,
      priceTrx: body.summa,
      currency: "TRX",
      // The status endpoint doesn't echo the original start/expiry -- the
      // caller already has both from rentEnergy()'s result / our own DB row.
      startedAt: "",
      expiresAt: "",
      status: toRentalStatus(body.status),
      txHash: body.txid,
    };
  }

  // cancelRental intentionally omitted -- see class doc comment.
}

function addDuration(fromIso: string, duration: EnergyRentalDuration): string {
  const ms: Record<EnergyRentalDuration, number> = {
    "1h": 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  };
  return new Date(new Date(fromIso).getTime() + ms[duration]).toISOString();
}
