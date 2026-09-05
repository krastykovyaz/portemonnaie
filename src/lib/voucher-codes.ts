/**
 * Voucher code generation + hashing.
 * Plaintext codes are NEVER persisted — only a SHA-256 hash is stored.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

function randomChars(length: number): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (const byte of buf) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** e.g. VCH-7FK2-9X4M-81PQ */
export function generateVoucherCode(): string {
  return `VCH-${randomChars(4)}-${randomChars(4)}-${randomChars(4)}`;
}

/** e.g. VPQ48KD2N9 — safe to expose in URLs and QR codes */
export function generatePublicId(): string {
  return `V${randomChars(9)}`;
}

export function normalizeVoucherCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

export async function hashVoucherCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeVoucherCode(code));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isPlausibleVoucherCode(code: string): boolean {
  return /^VCH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalizeVoucherCode(code));
}
