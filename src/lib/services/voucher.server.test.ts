import { beforeAll, describe, expect, it } from "vitest";
import { ensureSeeded } from "@/lib/db/bootstrap";
import { db, newId } from "@/lib/db/client";
import { createUser } from "@/lib/db/users";

beforeAll(() => ensureSeeded()); // the seeded AGT-A agent record is the assignment target below
import { hashVoucherCode } from "../voucher-codes";
import { assignVouchers, createBatch, listBatches, markVoucherSold } from "./voucher.server";

async function adminUser(): Promise<string> {
  const user = await createUser({ email: `issuer-${newId()}@test.local`, password: "test-password" });
  return user.id;
}

function agentId(): string {
  const row = db.query(`SELECT id FROM agents WHERE agent_ref = 'AGT-A'`).get() as { id: string };
  return row.id;
}

describe("voucher issuance (createBatch)", () => {
  it("issues exactly `quantity` vouchers with unique public ids and unique, hash-only codes", async () => {
    const actorId = await adminUser();
    const expiresAt = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    const { codes, batch } = await createBatch({
      denomination: 25,
      quantity: 5,
      expiresAt,
      actorId,
      actorLabel: "issuance-test",
    });

    expect(codes).toHaveLength(5);
    expect(new Set(codes.map((c) => c.public_id)).size).toBe(5);
    expect(new Set(codes.map((c) => c.code)).size).toBe(5);
    for (const c of codes) {
      expect(c.code).toMatch(/^VCH-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(c.denomination).toBe(25);
    }

    const rows = db
      .query(`SELECT public_id, code_hash, status, denomination, expires_at FROM vouchers WHERE batch_id = ?`)
      .all(batch.id) as Array<{ public_id: string; code_hash: string; status: string; denomination: number; expires_at: string }>;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.status).toBe("CREATED");
      expect(row.denomination).toBe(25);
      expect(row.expires_at).toBe(expiresAt);
      // Plaintext is never persisted — only its hash.
      const plain = codes.find((c) => c.public_id === row.public_id)!.code;
      expect(row.code_hash).not.toBe(plain);
      expect(row.code_hash).toBe(await hashVoucherCode(plain));
    }

    const listed = (await listBatches()).find((b) => b.id === batch.id);
    expect(listed?.issued).toBe(5);
  });

  it("walks a freshly issued voucher CREATED -> ASSIGNED -> SOLD", async () => {
    const actorId = await adminUser();
    const { codes } = await createBatch({
      denomination: 10,
      quantity: 1,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      actorId,
      actorLabel: "issuance-test",
    });
    const voucher = db.query(`SELECT id FROM vouchers WHERE public_id = ?`).get(codes[0]!.public_id) as {
      id: string;
    };
    const status = () =>
      (db.query(`SELECT status FROM vouchers WHERE id = ?`).get(voucher.id) as { status: string }).status;

    await assignVouchers({ voucherIds: [voucher.id], agentId: agentId(), actorId, actorLabel: "t" });
    expect(status()).toBe("ASSIGNED");
    await markVoucherSold({ voucherId: voucher.id, agentId: agentId(), actorId, actorLabel: "t" });
    expect(status()).toBe("SOLD");
  });
});
