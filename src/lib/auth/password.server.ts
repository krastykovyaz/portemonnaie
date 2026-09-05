/**
 * `Bun.password` isn't safe to rely on here — this app's server functions run
 * under whatever runtime TanStack Start's dev/prod server actually executes
 * them with, which is plain Node.js even when the outer process was started
 * via `bun run dev` (see src/lib/db/client.ts for the same lesson with
 * `bun:sqlite`). node:crypto's scrypt is available identically under both.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [scheme, salt, hex] = hash.split(":");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const stored = Buffer.from(hex, "hex");
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}
