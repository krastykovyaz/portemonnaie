import { db } from "@/lib/db/client";
import type { VoucherStatus } from "../domain/types";
import { getReconciliation } from "./ledger.server";
import { mapTransactionRow } from "./tx-map.server";

export type AdminOverview = {
  kpis: {
    totalVouchers: number;
    activeVouchers: number;
    soldVouchers: number;
    redeemedVouchers: number;
    totalValue: number;
    redeemedValue: number;
    outstandingLiability: number;
    treasury: number;
    fees: number;
  };
  statusBreakdown: Array<{ status: VoucherStatus; count: number }>;
  series: Array<{ date: string; issued: number; sold: number; redeemed: number }>;
  liabilitySeries: Array<{ date: string; liability: number }>;
  balanced: boolean;
};

const DAY = 24 * 60 * 60 * 1000;

function dayKey(value: string | null): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

export async function getAdminOverview(): Promise<AdminOverview> {
  const vouchers = db
    .query(`SELECT status, denomination, created_at, sold_at, redeemed_at FROM vouchers`)
    .all() as Array<{
    status: VoucherStatus;
    denomination: number;
    created_at: string;
    sold_at: string | null;
    redeemed_at: string | null;
  }>;

  const totalVouchers = vouchers.length;
  const totalValue = vouchers.reduce((sum, v) => sum + Number(v.denomination), 0);
  const soldVouchers = vouchers.filter((v) => v.status === "SOLD").length;
  const redeemed = vouchers.filter((v) => v.status === "REDEEMED");
  const activeVouchers = vouchers.filter((v) =>
    ["CREATED", "ASSIGNED", "SOLD"].includes(v.status),
  ).length;
  const redeemedValue = redeemed.reduce((sum, v) => sum + Number(v.denomination), 0);

  const statuses: VoucherStatus[] = [
    "CREATED",
    "ASSIGNED",
    "SOLD",
    "REDEEMING",
    "REDEEMED",
    "BLOCKED",
    "EXPIRED",
    "CANCELLED",
  ];
  const statusBreakdown = statuses
    .map((status) => ({ status, count: vouchers.filter((v) => v.status === status).length }))
    .filter((row) => row.count > 0);

  const days: string[] = [];
  const start = Date.now() - 29 * DAY;
  for (let i = 0; i < 30; i += 1) {
    days.push(new Date(start + i * DAY).toISOString().slice(0, 10));
  }

  const series = days.map((date) => ({
    date,
    issued: vouchers.filter((v) => dayKey(v.created_at) === date).length,
    sold: vouchers.filter((v) => dayKey(v.sold_at) === date).length,
    redeemed: vouchers.filter((v) => dayKey(v.redeemed_at) === date).length,
  }));

  const liabilitySeries = days.map((date) => {
    const cutoff = `${date}T23:59:59.999Z`;
    const liability = vouchers.reduce((sum, v) => {
      const sold = v.sold_at && v.sold_at <= cutoff;
      const redeemedBefore = v.redeemed_at && v.redeemed_at <= cutoff;
      return sold && !redeemedBefore ? sum + Number(v.denomination) : sum;
    }, 0);
    return { date, liability };
  });

  const reconciliation = await getReconciliation();

  return {
    kpis: {
      totalVouchers,
      activeVouchers,
      soldVouchers,
      redeemedVouchers: redeemed.length,
      totalValue,
      redeemedValue,
      outstandingLiability: reconciliation.liability,
      treasury: reconciliation.treasury,
      fees: reconciliation.fees,
    },
    statusBreakdown,
    series,
    liabilitySeries,
    balanced: reconciliation.balanced,
  };
}

export async function listTransactions(limit = 300) {
  const rows = db
    .query(
      `SELECT t.*, v.public_id AS voucher_public_id FROM transactions t
       LEFT JOIN vouchers v ON v.id = t.voucher_id
       ORDER BY t.created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) =>
    mapTransactionRow({
      ...row,
      vouchers: row["voucher_public_id"] ? { public_id: row["voucher_public_id"] } : null,
    }),
  );
}
