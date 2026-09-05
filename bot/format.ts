import { money, shortDate, truncateMiddle } from "@/lib/format";

export { money, shortDate, truncateMiddle };

export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function code(value: string): string {
  return `<code>${esc(value)}</code>`;
}

export function bulletList(lines: string[]): string {
  return lines.map((line) => `• ${line}`).join("\n");
}
