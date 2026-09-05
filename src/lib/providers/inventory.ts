/**
 * VoucherInventoryProvider — abstraction over *where vouchers come from*.
 *
 * Today the only implementation is InternalInventoryProvider (our own
 * voucher_batches / vouchers tables, reserved atomically in Postgres). An
 * external supplier adapter would implement the same three calls, so the order
 * flow never needs to know which source fulfilled an order.
 */
export type InventoryQuote = {
  providerId: string;
  denomination: number;
  asset: string;
  available: number;
  price: number;
};

export type InventoryReservation = {
  providerId: string;
  reservationRef: string;
  voucherId: string | null;
  expiresAt: string;
};

export interface VoucherInventoryProvider {
  readonly id: string;
  readonly external: boolean;
  quote(denomination: number): Promise<InventoryQuote>;
  /** Must be atomic and must never hand the same unit to two orders. */
  reserve(input: {
    denomination: number;
    orderRef: string;
    ttlMinutes: number;
  }): Promise<InventoryReservation | { error: string }>;
  release(reservationRef: string): Promise<void>;
}
