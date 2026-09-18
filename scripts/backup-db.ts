// On-demand database snapshot: `bun run db:backup`. Copies DATABASE_PATH into
// DB_BACKUP_DIR (default: <db dir>/backups) and keeps the newest 48. The cron
// sweep endpoint does the same automatically once an hour.
//
// Opens the database read-only for this purpose: it does NOT take the writer
// lock, so it can run alongside the live web app.
process.env["DATABASE_SHARED_WRITERS"] = "true";

const { backupDatabase } = await import("@/lib/db/backup.server");
const path = backupDatabase();
console.log("Backup written:", path);
