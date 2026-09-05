import type { TransactionWithVoucher } from "../domain/types";

export function mapTransactionRow(row: unknown): TransactionWithVoucher {
  const record = row as Record<string, unknown>;
  const voucher = record["vouchers"] as { public_id: string } | null | undefined;
  return {
    id: String(record["id"]),
    voucher_id: (record["voucher_id"] as string | null) ?? null,
    amount: Number(record["amount"]),
    asset: String(record["asset"]),
    network: String(record["network"]),
    destination_address: String(record["destination_address"]),
    tx_hash: (record["tx_hash"] as string | null) ?? null,
    status: record["status"] as TransactionWithVoucher["status"],
    confirmations: Number(record["confirmations"] ?? 0),
    created_at: String(record["created_at"]),
    confirmed_at: (record["confirmed_at"] as string | null) ?? null,
    voucher_public_id: voucher?.public_id ?? null,
  };
}
