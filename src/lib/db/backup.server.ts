import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_PATH } from "./client";

const DEFAULT_KEEP = 48;
const DEFAULT_MIN_INTERVAL_MS = 60 * 60 * 1000;
const PREFIX = "app-";

export function backupDir(): string {
  return process.env["DB_BACKUP_DIR"] ?? join(dirname(DB_PATH), "backups");
}

function listBackups(dir: string): Array<{ path: string; mtimeMs: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(".db"))
    .map((name) => {
      const path = join(dir, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Copies the on-disk database into the backup directory and prunes the
 * oldest beyond `keep`. Safe to run concurrently with writes: persistence is
 * an atomic rename, so the file being copied is always a complete snapshot.
 */
export function backupDatabase(opts: { dir?: string; keep?: number } = {}): string {
  const dir = opts.dir ?? backupDir();
  const keep = opts.keep ?? DEFAULT_KEEP;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(dir, `${PREFIX}${stamp}.db`);
  copyFileSync(DB_PATH, target);
  const backups = listBackups(dir);
  for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
    unlinkSync(stale.path);
  }
  return target;
}

/** Backs up only if the newest existing backup is older than `minIntervalMs`. Returns the new path or null. */
export function maybeBackupDatabase(
  opts: { dir?: string; keep?: number; minIntervalMs?: number; now?: number } = {},
): string | null {
  const dir = opts.dir ?? backupDir();
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now();
  const newest = listBackups(dir).at(-1);
  if (newest && now - newest.mtimeMs < minInterval) return null;
  return backupDatabase({ dir, ...(opts.keep !== undefined ? { keep: opts.keep } : {}) });
}
