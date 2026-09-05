export function requireBotToken(): string {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  return token;
}

export function adminIds(): number[] {
  const raw = process.env["TELEGRAM_ADMIN_IDS"] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}
