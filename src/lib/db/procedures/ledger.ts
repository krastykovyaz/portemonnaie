import { db, newId, nowIso } from "../client";

export type JournalLine = { account: string; direction: "DEBIT" | "CREDIT"; amount: number };

/** Post a balanced double-entry journal. Throws if debits and credits don't match to the cent. */
export function postJournal(
  lines: JournalLine[],
  voucherId: string | null = null,
  transactionId: string | null = null,
  memo: string | null = null,
): string {
  const debits = lines.filter((l) => l.direction === "DEBIT").reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.direction === "CREDIT").reduce((s, l) => s + l.amount, 0);
  if (Math.round(debits * 100) !== Math.round(credits * 100)) {
    throw new Error(`Unbalanced journal: debits ${debits} credits ${credits}`);
  }

  const journalId = newId();
  const now = nowIso();
  const insert = db.query(
    `INSERT INTO ledger_entries (id, journal_id, account_id, direction, amount, asset, voucher_id, transaction_id, memo, created_at)
     SELECT ?, ?, id, ?, ?, 'USDT', ?, ?, ?, ?
     FROM ledger_accounts WHERE code = ?`,
  );
  for (const line of lines) {
    const result = insert.run(
      newId(),
      journalId,
      line.direction,
      line.amount,
      voucherId,
      transactionId,
      memo,
      now,
      line.account,
    );
    if (result.changes === 0) throw new Error(`Unknown ledger account: ${line.account}`);
  }
  return journalId;
}
