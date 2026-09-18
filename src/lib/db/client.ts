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
import type { Database as SqlJsDatabase, SqlJsStatic } from "sql.js";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_SQL } from "./schema";

export const DB_PATH = process.env["DATABASE_PATH"] ?? join(process.cwd(), "data", "app.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

// Single-writer guard. Every process holds its own in-memory copy and
// rewrites the whole file on each write, so a second writer (the web app and
// the bot on one DATABASE_PATH) silently overwrites the other's data. Refuse
// to start instead. Same-pid re-imports (Vite HMR) are fine; a stale lock
// from a crashed process is ignored. Vitest workers legitimately share a
// throwaway file, and an operator can opt into the hazard explicitly.
const LOCK_PATH = `${DB_PATH}.lock`;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireWriterLock(): void {
  if (process.env["VITEST"] || process.env["DATABASE_SHARED_WRITERS"] === "true") return;
  if (existsSync(LOCK_PATH)) {
    const holder = Number(readFileSync(LOCK_PATH, "utf8").trim());
    if (Number.isFinite(holder) && holder !== process.pid && processAlive(holder)) {
      throw new Error(
        `DATABASE_LOCKED: ${DB_PATH} is already open for writing by pid ${holder}. ` +
          "sql.js holds the whole database in memory and rewrites the file on every write, so two " +
          "writer processes (web app + bot) silently overwrite each other. Stop the other process or " +
          "give it its own DATABASE_PATH. DATABASE_SHARED_WRITERS=true overrides this if you accept data loss.",
      );
    }
  }
  writeFileSync(LOCK_PATH, String(process.pid));
  process.once("exit", () => {
    try {
      if (readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_PATH);
    } catch {
      /* best effort */
    }
  });
}

acquireWriterLock();

// Write to a sibling temp file and rename over the target: rename is atomic
// on POSIX, so a crash mid-write leaves the previous complete database in
// place instead of a truncated one.
function writeAtomic(): void {
  const tmp = `${DB_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, Buffer.from(raw.export()));
  renameSync(tmp, DB_PATH);
}

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
// Loaded via require, not a static import: sql.js ships emscripten UMD code
// that calls require() internally. Bundled into an ESM chunk (the production
// Nitro build) that sits next to top-level await and Node refuses to load it.
// Keeping it opaque to the bundler means Node's CJS loader handles it in
// production exactly as it does under `vite dev`.
type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
const sqlJsModule = require("sql.js") as InitSqlJs & { default?: InitSqlJs };
const initSqlJs: InitSqlJs = sqlJsModule.default ?? sqlJsModule;
const SQL = await initSqlJs({ locateFile: () => wasmPath });

const raw: SqlJsDatabase = existsSync(DB_PATH)
  ? new SQL.Database(readFileSync(DB_PATH))
  : new SQL.Database();
raw.exec("PRAGMA foreign_keys = ON;");
raw.exec(SCHEMA_SQL);

// CREATE TABLE IF NOT EXISTS leaves existing tables untouched, so columns
// added to an already-created table (e.g. payouts' cost-accounting columns)
// need an explicit, idempotent migration here rather than in schema.ts.
function persistNow(): void {
  writeAtomic();
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const info = raw.exec(`PRAGMA table_info(${table})`);
  const existing = new Set((info[0]?.values ?? []).map((row) => row[1]));
  if (!existing.has(column)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn("payouts", "recipient_kind", "recipient_kind TEXT");
ensureColumn("payouts", "estimated_energy", "estimated_energy INTEGER");
ensureColumn("payouts", "actual_energy", "actual_energy INTEGER");
ensureColumn("payouts", "estimated_bandwidth", "estimated_bandwidth INTEGER");
ensureColumn("payouts", "actual_bandwidth", "actual_bandwidth INTEGER");
ensureColumn("payouts", "trx_burned", "trx_burned REAL");
ensureColumn("payouts", "trx_cost_usd", "trx_cost_usd REAL");
ensureColumn("payouts", "resource_source", "resource_source TEXT");
ensureColumn("payouts", "provider_cost", "provider_cost REAL");
ensureColumn("payouts", "total_network_cost", "total_network_cost REAL");
ensureColumn("payouts", "energy_rental_id", "energy_rental_id TEXT");
persistNow();

// Exporting the database (persist) mid-transaction ends the transaction
// early under the hood, so writes inside tx() must not trigger it — only the
// tx() wrapper persists, once, after COMMIT.
let inTransaction = false;

function persist(): void {
  if (inTransaction) return;
  writeAtomic();
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

// First-boot seeding lives in ./bootstrap (ensureSeeded), NOT here: seed.ts
// imports this module, so awaiting it from this module's own top level is an
// ESM cycle — under the real-ESM production build each side waits on the
// other forever (Vite's dev loader happened to tolerate it).
