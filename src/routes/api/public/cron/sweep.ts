import { createFileRoute } from "@tanstack/react-router";

/**
 * Recovery cron endpoint. Idempotent: it claims and continues unfinished
 * payments and payouts, releases expired reservations and records
 * reconciliation. Requires the CRON_SECRET bearer token.
 */
export const Route = createFileRoute("/api/public/cron/sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["CRON_SECRET"];
        if (!secret) return new Response("Cron not configured", { status: 503 });

        const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (provided.length !== secret.length || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { runPaymentSweep } = await import("@/lib/services/payment-monitor.server");
        const { runRecoverySweep } = await import("@/lib/services/payout.server");

        const payments = await runPaymentSweep({ limit: 50 });
        const payouts = await runRecoverySweep({ worker: "cron", limit: 25 });

        // Piggyback an hourly snapshot on the cron cadence: at most one copy
        // per hour, pruned to the last 48 (see src/lib/db/backup.server.ts).
        const { maybeBackupDatabase } = await import("@/lib/db/backup.server");
        let backup: string | null = null;
        try {
          backup = maybeBackupDatabase();
        } catch (error) {
          console.error(error);
        }

        return Response.json(
          {
            ok: true,
            payments: {
              checked: payments.checked,
              confirmed: payments.confirmed,
              stillOpen: payments.stillOpen,
              released: payments.released,
              problems: payments.problems.length,
            },
            payouts: {
              claimed: payouts.claimed,
              confirmed: payouts.confirmed,
              stillOpen: payouts.stillOpen,
              manualReview: payouts.manualReview,
            },
            backup,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
