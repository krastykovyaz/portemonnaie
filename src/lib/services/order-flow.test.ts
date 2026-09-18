import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, newId, nowIso } from "@/lib/db/client";
import { retryDelivery } from "./delivery.server";
import { createOrder } from "./order.server";
import { simulateCustomerPayment } from "./payment-monitor.server";
import { previewVoucher } from "./redemption.server";

let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env["CHAIN_MODE"];
  process.env["CHAIN_MODE"] = "DEMO";
});
afterEach(() => {
  if (savedMode === undefined) delete process.env["CHAIN_MODE"];
  else process.env["CHAIN_MODE"] = savedMode;
});

/** Guarantee stock for the denomination regardless of what the seed left behind. */
function stockVoucher(denomination: number): void {
  const id = newId();
  const now = nowIso();
  db.query(
    `INSERT INTO vouchers (id, public_id, code_hash, asset, network, denomination, status, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, 'USDT', 'TRON_TESTNET', ?, 'CREATED', ?, ?, ?)`,
  ).run(id, `TESTO${id.slice(0, 10)}`, `hash_${id}`, denomination, now, new Date(Date.now() + 86_400_000).toISOString(), now);
}

describe("order -> simulated payment -> fulfilment -> delivery (DEMO)", () => {
  it("delivers a voucher code exactly once, and a replayed order returns the same order", async () => {
    stockVoucher(10);
    const key = `order-${newId()}`;
    const order = await createOrder({ denomination: 10, idempotencyKey: key });
    expect(order.ok).toBe(true);
    if (!order.ok) throw new Error("unreachable");
    expect(order.replayed).toBe(false);

    const replay = await createOrder({ denomination: 10, idempotencyKey: key });
    expect(replay.ok && replay.replayed).toBe(true);
    if (replay.ok) expect(replay.publicOrderId).toBe(order.publicOrderId);

    const paid = await simulateCustomerPayment({ paymentId: order.paymentId });
    expect(paid.ok).toBe(true);
    if (!paid.ok) throw new Error("unreachable");
    const fulfilment = paid.outcome.fulfilment;
    expect(fulfilment?.ok).toBe(true);
    if (!fulfilment?.ok || fulfilment.replayed) throw new Error("expected a fresh delivery");

    const { code, voucherPublicId } = fulfilment;
    expect(code).toMatch(/^VCH-/);

    const voucher = db.query(`SELECT status FROM vouchers WHERE public_id = ?`).get(voucherPublicId) as {
      status: string;
    };
    expect(voucher.status).toBe("SOLD");

    // The delivered code is the one the customer can actually redeem with.
    const preview = await previewVoucher(voucherPublicId, code);
    expect(preview.ok).toBe(true);

    // Paying again for the same order never issues a second code.
    const again = await simulateCustomerPayment({ paymentId: order.paymentId });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.outcome.fulfilment?.ok && again.outcome.fulfilment.replayed).toBe(true);
  });

  it("re-issuing a code invalidates the previous one", async () => {
    stockVoucher(10);
    const order = await createOrder({ denomination: 10, idempotencyKey: `order-${newId()}` });
    if (!order.ok) throw new Error("order failed");
    const paid = await simulateCustomerPayment({ paymentId: order.paymentId });
    if (!paid.ok || !paid.outcome.fulfilment?.ok || paid.outcome.fulfilment.replayed) {
      throw new Error("fulfilment failed");
    }
    const { code: oldCode, voucherPublicId } = paid.outcome.fulfilment;

    const reissued = await retryDelivery(order.orderId);
    expect(reissued.ok).toBe(true);
    if (!reissued.ok) throw new Error("unreachable");
    expect(reissued.code).not.toBe(oldCode);

    const stale = await previewVoucher(voucherPublicId, oldCode);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toBe("INVALID_CODE");
    const fresh = await previewVoucher(voucherPublicId, reissued.code);
    expect(fresh.ok).toBe(true);
  });
});
