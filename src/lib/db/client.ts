/**
 * SQLite via sql.js (pure WASM, no native bindings). This app's SSR code runs
 * under whatever loader TanStack Start's dev/prod server happens to use —
 * `bun:sqlite` only works when a script is launched directly with `bun run`,
 * and `better-sqlite3`'s native binding currently crashes Bun's N-API layer —
 * so a WASM engine is the one driver that behaves identically everywhere
 * (`bun run dev`, the built server, and `bun run bot`).
 *
 * Trade-off: the whole database is an in-memory buffer that gets exported to
 * disk after every write. There is no real file locking, so the web app and
 * the bot must not write concurrently against the same DATABASE_PATH — each
 * holds its own in-memory copy and the last process to flush wins. Fine for
 * a single-writer demo; genuinely concurrent access would need a real
 * server-mode database.
 */
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_SQL } from "./schema";

const DB_PATH = process.env["DATABASE_PATH"] ?? join(process.cwd(), "data", "app.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
const SQL = await initSqlJs({ locateFile: () => wasmPath });

const raw: SqlJsDatabase = existsSync(DB_PATH)
  ? new SQL.Database(readFileSync(DB_PATH))
  : new SQL.Database();
raw.exec("PRAGMA foreign_keys = ON;");
raw.exec(SCHEMA_SQL);

// Exporting the database (persist) mid-transaction ends the transaction
// early under the hood, so writes inside tx() must not trigger it — only the
// tx() wrapper persists, once, after COMMIT.
let inTransaction = false;

function persist(): void {
  if (inTransaction) return;
  writeFileSync(DB_PATH, Buffer.from(raw.export()));
}

type Bind = ReadonlyArray<string | number | null | Uint8Array>;

class Stmt {
  constructor(private readonly sql: string) {}

  run(...params: Bind): { changes: number } {
    raw.run(this.sql, params as never);
    // getRowsModified() must be read before persist() — db.export() touches
    // the connection and resets the sqlite3_changes() counter it reads.
    const changes = raw.getRowsModified();
    persist();
    return { changes };
  }

  get(...params: Bind): Record<string, unknown> | null {
    const stmt = raw.prepare(this.sql);
    try {
      stmt.bind(params as never);
      return stmt.step() ? stmt.getAsObject() : null;
    } finally {
      stmt.free();
    }
  }

  all(...params: Bind): Array<Record<string, unknown>> {
    const stmt = raw.prepare(this.sql);
    try {
      stmt.bind(params as never);
      const rows: Array<Record<string, unknown>> = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }
}

export const db = {
  query(sql: string): Stmt {
    return new Stmt(sql);
  },
  exec(sql: string): void {
    raw.exec(sql);
    persist();
  },
};

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Runs `fn` inside a SQLite transaction; rolls back on throw. Mirrors the atomicity the Postgres functions relied on. */
export function tx<T>(fn: () => T): T {
  if (inTransaction) return fn(); // sql.js has no nested transactions; the outer tx() already owns commit/rollback.
  raw.exec("BEGIN");
  inTransaction = true;
  try {
    const result = fn();
    raw.exec("COMMIT");
    inTransaction = false;
    persist();
    return result;
  } catch (error) {
    inTransaction = false;
    raw.exec("ROLLBACK");
    throw error;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function fromJson<T = Record<string, unknown>>(json: string | null | undefined): T {
  if (!json) return {} as T;
  try {
    return JSON.parse(json) as T;
  } catch {
    return {} as T;
  }
}

// Auto-seed on first boot from any entry point (web app or bot) so a fresh
// clone isn't blank. Dynamic import avoids a static circular dependency with
// ./seed, which itself imports `db` from this module.
const voucherCount = (db.query(`SELECT COUNT(*) AS n FROM vouchers`).get() as { n: number }).n;
if (voucherCount === 0) {
  const { seedDemoData } = await import("./seed");
  await seedDemoData();
}
