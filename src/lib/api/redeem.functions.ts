import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const previewSchema = z.object({
  publicId: z.string().min(4).max(32),
  code: z.string().min(8).max(32),
});

const redeemSchema = previewSchema.extend({
  destination: z.string().min(20).max(64),
});

/**
 * Public endpoints — the customer redemption flow is intentionally unauthenticated,
 * but every request must present the voucher secret, which is only ever compared
 * against a stored hash inside the database.
 */
export const previewVoucherFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => previewSchema.parse(input))
  .handler(async ({ data }) => {
    const { previewVoucher, explainError } = await import("../services/redemption.server");
    const preview = await previewVoucher(data.publicId.toUpperCase(), data.code);
    if (!preview.ok) {
      return { ok: false as const, message: explainError(preview.error, preview.status) };
    }
    return {
      ok: true as const,
      voucher: {
        public_id: preview.public_id,
        asset: preview.asset,
        network: preview.network,
        denomination: Number(preview.denomination),
        expires_at: preview.expires_at,
      },
    };
  });

export const validateAddressFn = createServerFn({ method: "POST" })
  .inputValidator((input: { address: string }) => input)
  .handler(async ({ data }) => {
    const { validateDestinationAddress } = await import("../services/redemption.server");
    return { valid: validateDestinationAddress(data.address) };
  });

export const redeemVoucherFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => redeemSchema.parse(input))
  .handler(async ({ data }) => {
    const { redeemVoucher } = await import("../services/redemption.server");
    const outcome = await redeemVoucher({
      publicId: data.publicId.toUpperCase(),
      code: data.code,
      destination: data.destination,
    });
    if (!outcome.ok) return { ok: false as const, message: outcome.error };
    return { ok: true as const, result: outcome.result };
  });
