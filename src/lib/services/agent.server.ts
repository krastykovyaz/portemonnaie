import { db, nowIso } from "@/lib/db/client";
import type { AgentRow, TransactionWithVoucher, VoucherWithAgent } from "../domain/types";
import { mapTransactionRow } from "./tx-map.server";

export async function listAgents() {
  const agents = db.query(`SELECT * FROM agents ORDER BY agent_ref`).all() as AgentRow[];
  const vouchers = db
    .query(`SELECT assigned_agent_id, status, denomination FROM vouchers`)
    .all() as Array<{
    assigned_agent_id: string | null;
    status: string;
    denomination: number;
  }>;

  return agents.map((agent) => {
    const rows = vouchers.filter((v) => v.assigned_agent_id === agent.id);
    const sold = rows.filter((v) => v.status === "SOLD" || v.status === "REDEEMED");
    const salesValue = sold.reduce((sum, v) => sum + Number(v.denomination), 0);
    return {
      ...agent,
      inventory: rows.filter((v) => v.status === "ASSIGNED" || v.status === "CREATED").length,
      sold: sold.length,
      redeemed: rows.filter((v) => v.status === "REDEEMED").length,
      salesValue,
      commission: Number((salesValue * Number(agent.commission_rate)).toFixed(2)),
    };
  });
}

export async function getAgentByUser(userId: string): Promise<AgentRow | null> {
  return (
    (db.query(`SELECT * FROM agents WHERE user_id = ?`).get(userId) as AgentRow | null) ?? null
  );
}

/** Bot-only: agents linked to a Telegram account have no Supabase auth user. */
export async function getAgentByTelegramId(telegramUserId: number): Promise<AgentRow | null> {
  return (
    (db
      .query(`SELECT * FROM agents WHERE telegram_user_id = ?`)
      .get(telegramUserId) as AgentRow | null) ?? null
  );
}

/** Admin-only, via the bot's /linkagent command. */
export async function linkAgentTelegram(
  agentRef: string,
  telegramUserId: number,
): Promise<AgentRow | null> {
  const now = nowIso();
  const result = db
    .query(`UPDATE agents SET telegram_user_id = ?, updated_at = ? WHERE agent_ref = ?`)
    .run(telegramUserId, now, agentRef);
  if (result.changes === 0) return null;
  return (
    (db.query(`SELECT * FROM agents WHERE agent_ref = ?`).get(agentRef) as AgentRow | null) ?? null
  );
}

export async function getAgentWorkspace(userId: string) {
  return buildAgentWorkspace(await getAgentByUser(userId));
}

export async function getAgentWorkspaceByTelegramId(telegramUserId: number) {
  return buildAgentWorkspace(await getAgentByTelegramId(telegramUserId));
}

function buildAgentWorkspace(agent: AgentRow | null) {
  if (!agent)
    return {
      agent: null,
      vouchers: [] as VoucherWithAgent[],
      transactions: [] as TransactionWithVoucher[],
      stats: null,
    };

  const rows = db
    .query(`SELECT * FROM vouchers WHERE assigned_agent_id = ? ORDER BY created_at DESC`)
    .all(agent.id) as unknown as VoucherWithAgent[];
  const sold = rows.filter((v) => v.status === "SOLD" || v.status === "REDEEMED");
  const salesValue = sold.reduce((sum, v) => sum + Number(v.denomination), 0);

  const voucherIds = rows.map((v) => v.id);
  let transactions: TransactionWithVoucher[] = [];
  if (voucherIds.length > 0) {
    const txRows = db
      .query(
        `SELECT t.*, v.public_id AS voucher_public_id FROM transactions t
         LEFT JOIN vouchers v ON v.id = t.voucher_id
         WHERE t.voucher_id IN (${voucherIds.map(() => "?").join(",")})
         ORDER BY t.created_at DESC LIMIT 200`,
      )
      .all(...voucherIds) as Array<Record<string, unknown>>;
    transactions = txRows.map((row) =>
      mapTransactionRow({
        ...row,
        vouchers: row["voucher_public_id"] ? { public_id: row["voucher_public_id"] } : null,
      }),
    );
  }

  return {
    agent,
    vouchers: rows,
    transactions,
    stats: {
      inventory: rows.filter((v) => v.status === "ASSIGNED" || v.status === "CREATED").length,
      available: rows.filter((v) => v.status === "ASSIGNED").length,
      sold: rows.filter((v) => v.status === "SOLD").length,
      redeemed: rows.filter((v) => v.status === "REDEEMED").length,
      salesValue,
      commission: Number((salesValue * Number(agent.commission_rate)).toFixed(2)),
    },
  };
}
