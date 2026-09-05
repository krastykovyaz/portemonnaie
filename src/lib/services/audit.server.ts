import { db, newId, nowIso, toJson, fromJson } from "@/lib/db/client";
import type { AuditRow, JsonValue } from "../domain/types";

export type AuditEvent = {
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, JsonValue>;
};

/** Synchronous variant for use inside a db.transaction() callback (e.g. the procedures/* modules). */
export function writeAuditSync(event: AuditEvent): void {
  db.query(
    `INSERT INTO audit_logs (id, actor_id, actor_label, action, entity, entity_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    event.actorId ?? null,
    event.actorLabel ?? null,
    event.action,
    event.entity,
    event.entityId ?? null,
    toJson(event.metadata ?? {}),
    nowIso(),
  );
}

export async function writeAudit(event: AuditEvent): Promise<void> {
  writeAuditSync(event);
}

export async function listAudit(limit = 200): Promise<AuditRow[]> {
  const rows = db
    .query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row["id"]),
    actor_id: (row["actor_id"] as string | null) ?? null,
    actor_label: (row["actor_label"] as string | null) ?? null,
    action: String(row["action"]),
    entity: String(row["entity"]),
    entity_id: (row["entity_id"] as string | null) ?? null,
    metadata: fromJson(row["metadata"] as string),
    created_at: String(row["created_at"]),
  }));
}
