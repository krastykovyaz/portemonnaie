import { db } from "./client";

let seeding: Promise<void> | null = null;

/**
 * Seeds the demo dataset once if the database is empty. Called by each entry
 * point (server request handler, bot) rather than at DB-module import time —
 * see the note at the bottom of ./client.ts for why that deadlocks under the
 * production ESM build. Idempotent and memoized: concurrent first requests
 * share one seeding run.
 */
export function ensureSeeded(): Promise<void> {
  if (!seeding) {
    seeding = (async () => {
      const { n } = db.query(`SELECT COUNT(*) AS n FROM vouchers`).get() as { n: number };
      if (n > 0) return;
      const { seedDemoData } = await import("./seed");
      await seedDemoData();
    })().catch((error) => {
      seeding = null; // let a later request retry rather than caching the failure forever
      throw error;
    });
  }
  return seeding;
}
