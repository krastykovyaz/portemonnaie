import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase, maybeBackupDatabase } from "./backup.server";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vr-backup-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("database backups", () => {
  it("copies the live database into the backup dir", () => {
    const dir = tempDir();
    const path = backupDatabase({ dir });
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("prunes the oldest backups beyond `keep`", () => {
    const dir = tempDir();
    const first = backupDatabase({ dir, keep: 2 });
    utimesSync(first, new Date(Date.now() - 3_000), new Date(Date.now() - 3_000));
    const second = backupDatabase({ dir, keep: 2 });
    utimesSync(second, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
    backupDatabase({ dir, keep: 2 });
    const remaining = readdirSync(dir);
    expect(remaining).toHaveLength(2);
    expect(existsSync(first)).toBe(false);
  });

  it("maybeBackupDatabase skips while the newest backup is fresh, then backs up once it's stale", () => {
    const dir = tempDir();
    const t0 = Date.now();
    expect(maybeBackupDatabase({ dir, minIntervalMs: 60_000, now: t0 })).not.toBeNull();
    expect(maybeBackupDatabase({ dir, minIntervalMs: 60_000, now: t0 + 1_000 })).toBeNull();
    expect(maybeBackupDatabase({ dir, minIntervalMs: 60_000, now: t0 + 61_000 })).not.toBeNull();
    expect(readdirSync(dir)).toHaveLength(2);
  });
});
