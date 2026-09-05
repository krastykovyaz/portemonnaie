import { db } from "@/lib/db/client";
import type { LedgerBalance, LedgerEntryRow } from "../domain/types";

export async function getLedgerBalances(): Promise<LedgerBalance[]> {
  const rows = db
    .query(
      `SELECT a.code, a.name, a.account_type,
        COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE 0 END), 0) AS debits,
        COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE 0 END), 0) AS credits
       FROM ledger_accounts a
       LEFT JOIN ledger_entries e ON e.account_id = a.id
       GROUP BY a.code, a.name, a.account_type
       ORDER BY a.code`,
    )
    .all() as Array<{
    code: string;
    name: string;
    account_type: string;
    debits: number;
    credits: number;
  }>;

  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    account_type: row.account_type,
    debits: row.debits,
    credits: row.credits,
    balance: row.debits - row.credits,
  }));
}

export async function listLedgerEntries(limit = 200): Promise<LedgerEntryRow[]> {
  const rows = db
    .query(
      `SELECT e.id, e.journal_id, e.direction, e.amount, e.asset, e.memo, e.created_at, a.code AS account_code
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       ORDER BY e.created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row["id"]),
    journal_id: String(row["journal_id"]),
    direction: row["direction"] as "DEBIT" | "CREDIT",
    amount: Number(row["amount"]),
    asset: String(row["asset"]),
    memo: (row["memo"] as string | null) ?? null,
    created_at: String(row["created_at"]),
    account_code: (row["account_code"] as string | null) ?? "—",
  }));
}

export async function getReconciliation() {
  const balances = await getLedgerBalances();
  const byCode = Object.fromEntries(balances.map((b) => [b.code, b]));
  const treasury = byCode["TREASURY_USDT"]?.balance ?? 0;
  const liability = -(byCode["VOUCHER_LIABILITY"]?.balance ?? 0);
  const payouts = byCode["CUSTOMER_PAYOUT"]?.balance ?? 0;
  const fees = -(byCode["FEES"]?.balance ?? 0);
  const totalDebits = balances.reduce((sum, b) => sum + b.debits, 0);
  const totalCredits = balances.reduce((sum, b) => sum + b.credits, 0);
  return {
    balances,
    treasury,
    liability,
    payouts,
    fees,
    totalDebits,
    totalCredits,
    balanced: Math.abs(totalDebits - totalCredits) < 0.005,
  };
}
