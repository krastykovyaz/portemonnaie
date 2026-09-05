import { db, newId, nowIso, toJson } from "../client";
import { writeAuditSync } from "@/lib/services/audit.server";

export function manualReviewOpen(input: {
  kind: string;
  subjectType: string;
  subjectId: string;
  detail: string;
  severity?: string;
  orderId?: string | null;
  paymentId?: string | null;
  voucherId?: string | null;
  payoutId?: string | null;
  metadata?: Record<string, unknown>;
  dedupeKey?: string | null;
}): string {
  const now = nowIso();
  const dedupeKey = input.dedupeKey ?? `${input.kind}:${input.subjectId}`;
  const existing = db
    .query(`SELECT id FROM manual_reviews WHERE dedupe_key = ?`)
    .get(dedupeKey) as { id: string } | null;
  if (existing) {
    db.query(`UPDATE manual_reviews SET detail = ?, updated_at = ? WHERE id = ?`).run(
      input.detail,
      now,
      existing.id,
    );
    return existing.id;
  }
  const id = newId();
  db.query(
    `INSERT INTO manual_reviews (id, kind, severity, subject_type, subject_id, order_id, payment_id,
      voucher_id, payout_id, detail, metadata, dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.severity ?? "WARNING",
    input.subjectType,
    input.subjectId,
    input.orderId ?? null,
    input.paymentId ?? null,
    input.voucherId ?? null,
    input.payoutId ?? null,
    input.detail,
    toJson(input.metadata ?? {}),
    dedupeKey,
    now,
    now,
  );
  return id;
}

export function manualReviewResolve(input: {
  reviewId: string;
  resolution: string;
  status: "RESOLVED" | "REJECTED";
  actorId?: string | null;
  actorLabel: string;
}): { ok: boolean; error?: string } {
  const now = nowIso();
  const result = db
    .query(
      `UPDATE manual_reviews SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(input.status, input.resolution, input.actorId ?? null, now, now, input.reviewId);
  if (result.changes === 0) return { ok: false, error: "NOT_FOUND" };
  writeAuditSync({
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel,
    action: "MANUAL_REVIEW_RESOLVED",
    entity: "manual_review",
    entityId: input.reviewId,
    metadata: { status: input.status, resolution: input.resolution },
  });
  return { ok: true };
}
