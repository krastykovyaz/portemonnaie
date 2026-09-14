import { describe, expect, it } from "vitest";
import { newId, nowIso } from "../client";
import {
  createPendingRental,
  expireStaleRentals,
  getRentalById,
  getRentalByIdempotencyKey,
  markRentalActive,
  markRentalFailed,
} from "./energy-rentals";

describe("energy_rentals procedures", () => {
  it("createPendingRental is idempotent: a retry with the same key returns the existing row, not a second insert", () => {
    const key = `test-rental-${newId()}`;
    const first = createPendingRental({
      provider: "mock-energy-rental",
      treasuryAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      requestedEnergy: 20000,
      duration: "1h",
      idempotencyKey: key,
    });
    expect(first.created).toBe(true);

    const second = createPendingRental({
      provider: "mock-energy-rental",
      treasuryAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      requestedEnergy: 20000,
      duration: "1h",
      idempotencyKey: key,
    });
    expect(second.created).toBe(false);
    expect(second.rental.id).toBe(first.rental.id);

    const byKey = getRentalByIdempotencyKey(key);
    expect(byKey?.id).toBe(first.rental.id);
  });

  it("markRentalActive transitions a PENDING rental to ACTIVE with delegation details", () => {
    const key = `test-rental-${newId()}`;
    const { rental } = createPendingRental({
      provider: "mock-energy-rental",
      treasuryAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      requestedEnergy: 65000,
      duration: "1h",
      idempotencyKey: key,
    });
    markRentalActive(rental.id, {
      providerOrderId: "12345",
      delegatedEnergy: 65000,
      priceTrx: 6.5,
      priceUsd: 0.975,
      startedAt: nowIso(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      txHash: "mock_tx_1",
    });
    const updated = getRentalById(rental.id);
    expect(updated?.status).toBe("ACTIVE");
    expect(updated?.delegated_energy).toBe(65000);
    expect(updated?.price_usd).toBeCloseTo(0.975, 6);
  });

  it("markRentalFailed transitions a PENDING rental to FAILED with the error recorded", () => {
    const key = `test-rental-${newId()}`;
    const { rental } = createPendingRental({
      provider: "mock-energy-rental",
      treasuryAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      requestedEnergy: 65000,
      duration: "1h",
      idempotencyKey: key,
    });
    markRentalFailed(rental.id, "MOCK_RENTAL_FAILED");
    const updated = getRentalById(rental.id);
    expect(updated?.status).toBe("FAILED");
    expect(updated?.error_message).toBe("MOCK_RENTAL_FAILED");
  });

  it("expireStaleRentals only sweeps ACTIVE rentals whose expiry has passed, leaving current ones untouched", () => {
    const expiredKey = `test-rental-${newId()}`;
    const activeKey = `test-rental-${newId()}`;

    const expired = createPendingRental({
      provider: "mock-energy-rental",
      treasuryAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      requestedEnergy: 65000,
      duration: "1h",
      idempotencyKey: expiredKey,
    }).rental;
    markRentalActive(expired.id, {
      providerOrderId: "1",
      delegatedEnergy: 65000,
      priceTrx: 6.5,
      priceUsd: 0.975,
      startedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(), // expired an hour ago
      txHash: "mock_tx_expired",
    });

    const active = createPendingRental({
      provider: "mock-energy-rental",
      treasuryAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      requestedEnergy: 65000,
      duration: "1d",
      idempotencyKey: activeKey,
    }).rental;
    markRentalActive(active.id, {
      providerOrderId: "2",
      delegatedEnergy: 65000,
      priceTrx: 6.5,
      priceUsd: 0.975,
      startedAt: nowIso(),
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(), // still valid
      txHash: "mock_tx_active",
    });

    const swept = expireStaleRentals();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(getRentalById(expired.id)?.status).toBe("EXPIRED");
    expect(getRentalById(active.id)?.status).toBe("ACTIVE");
  });
});
