import { db, newId, nowIso, tx } from "@/lib/db/client";
import { postJournal } from "@/lib/db/procedures/ledger";
import {
  ASSET,
  NETWORK,
  type VoucherRow,
  type VoucherStatus,
  type VoucherWithAgent,
} from "../domain/types";
import { generatePublicId, generateVoucherCode, hashVoucherCode } from "../voucher-codes";
import { writeAudit, writeAuditSync } from "./audit.server";

export type CreatedVoucherCode = { public_id: string; code: string; denomination: number };

export type VoucherBatchRow = {
  id: string;
  batch_ref: string;
  asset: string;
  network: string;
  denomination: number;
  quantity: number;
  expires_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type VoucherDetail = VoucherRow & {
  agent_name: string | null;
  agent_ref: string | null;
  batch_ref: string | null;
};

export type VoucherTransaction = {
  id: string;
  voucher_id: string | null;
  redemption_id: string | null;
  user_id: string | null;
  amount: number;
  asset: string;
  network: string;
  destination_address: string;
  tx_hash: string | null;
  status: string;
  confirmations: number;
  created_at: string;
  confirmed_at: string | null;
};

export async function createBatch(input: {
  denomination: number;
  quantity: number;
  expiresAt: string;
  actorId: string;
  actorLabel: string;
}) {
  const batchRef = `BATCH-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${String(
    input.denomination,
  ).padStart(3, "0")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const batchId = newId();
  const now = nowIso();
  db.query(
    `INSERT INTO voucher_batches (id, batch_ref, asset, network, denomination, quantity, expires_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    batchId,
    batchRef,
    ASSET,
    NETWORK,
    input.denomination,
    input.quantity,
    input.expiresAt,
    input.actorId,
    now,
    now,
  );

  const codes: CreatedVoucherCode[] = [];
  const insert = db.query(
    `INSERT INTO vouchers (id, public_id, code_hash, asset, network, denomination, status, batch_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?)`,
  );
  for (let i = 0; i < input.quantity; i += 1) {
    const code = generateVoucherCode();
    const publicId = generatePublicId();
    codes.push({ public_id: publicId, code, denomination: input.denomination });
    insert.run(
      newId(),
      publicId,
      await hashVoucherCode(code),
      ASSET,
      NETWORK,
      input.denomination,
      batchId,
      input.expiresAt,
      now,
      now,
    );
  }

  await writeAudit({
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    action: "VOUCHER_BATCH_GENERATED",
    entity: "voucher_batch",
    entityId: batchRef,
    metadata: { quantity: input.quantity, denomination: input.denomination },
  });

  const batch = db
    .query(`SELECT * FROM voucher_batches WHERE id = ?`)
    .get(batchId) as VoucherBatchRow;
  return { batch, codes };
}

export async function listVouchers(filters: {
  status?: VoucherStatus | "ALL";
  agentId?: string | null;
  batchId?: string | null;
  search?: string;
  limit?: number;
}): Promise<VoucherWithAgent[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.status && filters.status !== "ALL") {
    clauses.push("v.status = ?");
    params.push(filters.status);
  }
  if (filters.agentId) {
    clauses.push("v.assigned_agent_id = ?");
    params.push(filters.agentId);
  }
  if (filters.batchId) {
    clauses.push("v.batch_id = ?");
    params.push(filters.batchId);
  }
  if (filters.search) {
    clauses.push("v.public_id LIKE ?");
    params.push(`%${filters.search.toUpperCase()}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(filters.limit ?? 500);

  const rows = db
    .query(
      `SELECT v.*, a.name AS agent_name FROM vouchers v LEFT JOIN agents a ON a.id = v.assigned_agent_id
       ${where} ORDER BY v.created_at DESC LIMIT ?`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows as unknown as VoucherWithAgent[];
}

export async function listBatches() {
  const batches = db
    .query(`SELECT * FROM voucher_batches ORDER BY created_at DESC`)
    .all() as VoucherBatchRow[];
  const counts = db.query(`SELECT batch_id, status FROM vouchers`).all() as Array<{
    batch_id: string | null;
    status: string;
  }>;
  return batches.map((batch) => {
    const rows = counts.filter((c) => c.batch_id === batch.id);
    return {
      ...batch,
      issued: rows.length,
      sold: rows.filter((r) => r.status === "SOLD").length,
      redeemed: rows.filter((r) => r.status === "REDEEMED").length,
    };
  });
}

export async function assignVouchers(input: {
  voucherIds: string[];
  agentId: string;
  actorId: string;
  actorLabel: string;
}) {
  const placeholders = input.voucherIds.map(() => "?").join(",");
  const eligible = db
    .query(
      `SELECT id, public_id FROM vouchers WHERE id IN (${placeholders}) AND status IN ('CREATED','ASSIGNED')`,
    )
    .all(...input.voucherIds) as Array<{ id: string; public_id: string }>;
  if (eligible.length > 0) {
    const ids = eligible.map((v) => v.id);
    db.query(
      `UPDATE vouchers SET status = 'ASSIGNED', assigned_agent_id = ?, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(input.agentId, nowIso(), ...ids);
  }

  await writeAudit({
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    action: "VOUCHER_ASSIGNED",
    entity: "voucher",
    entityId: eligible.map((v) => v.public_id).join(","),
    metadata: { agent_id: input.agentId, count: eligible.length },
  });
  return { assigned: eligible.length };
}

function setStatus(input: {
  voucherId: string;
  next: VoucherStatus;
  allowedFrom: VoucherStatus[];
  action: string;
  actorId: string | null;
  actorLabel: string;
}) {
  return tx(() => {
    const placeholders = input.allowedFrom.map(() => "?").join(",");
    const result = db
      .query(
        `UPDATE vouchers SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(input.next, nowIso(), input.voucherId, ...input.allowedFrom);
    if (result.changes === 0) throw new Error("Voucher is not in a state that allows this action");
    const data = db
      .query(`SELECT public_id, status FROM vouchers WHERE id = ?`)
      .get(input.voucherId) as {
      public_id: string;
      status: string;
    };
    writeAuditSync({
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      action: input.action,
      entity: "voucher",
      entityId: data.public_id,
      metadata: { new_status: input.next },
    });
    return data;
  });
}

export async function blockVoucher(voucherId: string, actorId: string | null, actorLabel: string) {
  return setStatus({
    voucherId,
    next: "BLOCKED",
    allowedFrom: ["CREATED", "ASSIGNED", "SOLD"],
    action: "VOUCHER_BLOCKED",
    actorId,
    actorLabel,
  });
}

export async function cancelVoucher(voucherId: string, actorId: string | null, actorLabel: string) {
  return setStatus({
    voucherId,
    next: "CANCELLED",
    allowedFrom: ["CREATED", "ASSIGNED", "BLOCKED"],
    action: "VOUCHER_CANCELLED",
    actorId,
    actorLabel,
  });
}

export async function unblockVoucher(
  voucherId: string,
  actorId: string | null,
  actorLabel: string,
) {
  return setStatus({
    voucherId,
    next: "ASSIGNED",
    allowedFrom: ["BLOCKED"],
    action: "VOUCHER_UNBLOCKED",
    actorId,
    actorLabel,
  });
}

/** Agent action: no blockchain activity happens on sale, only a ledger journal. */
export async function markVoucherSold(input: {
  voucherId: string;
  agentId: string;
  actorId: string | null;
  actorLabel: string;
}) {
  return tx(() => {
    const now = nowIso();
    const result = db
      .query(
        `UPDATE vouchers SET status = 'SOLD', sold_at = ?, updated_at = ? WHERE id = ? AND assigned_agent_id = ? AND status IN ('CREATED','ASSIGNED')`,
      )
      .run(now, now, input.voucherId, input.agentId);
    if (result.changes === 0) throw new Error("Voucher cannot be marked as sold");

    const voucher = db.query(`SELECT * FROM vouchers WHERE id = ?`).get(input.voucherId) as {
      id: string;
      public_id: string;
      status: string;
      denomination: number;
    };

    postJournal(
      [
        { account: "TREASURY_USDT", direction: "DEBIT", amount: voucher.denomination },
        { account: "VOUCHER_LIABILITY", direction: "CREDIT", amount: voucher.denomination },
      ],
      voucher.id,
      null,
      `Voucher sold ${voucher.public_id}`,
    );

    writeAuditSync({
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      action: "VOUCHER_SOLD",
      entity: "voucher",
      entityId: voucher.public_id,
      metadata: { denomination: voucher.denomination, agent_id: input.agentId },
    });
    return voucher;
  });
}

export async function getVoucherDetail(voucherId: string) {
  const voucher = db
    .query(
      `SELECT v.*, a.name AS agent_name, a.agent_ref AS agent_ref, b.batch_ref AS batch_ref
       FROM vouchers v
       LEFT JOIN agents a ON a.id = v.assigned_agent_id
       LEFT JOIN voucher_batches b ON b.id = v.batch_id
       WHERE v.id = ?`,
    )
    .get(voucherId) as VoucherDetail | null;
  if (!voucher) throw new Error("Voucher not found");

  const transactions = db
    .query(`SELECT * FROM transactions WHERE voucher_id = ? ORDER BY created_at DESC`)
    .all(voucherId) as VoucherTransaction[];

  return { voucher, transactions };
}
