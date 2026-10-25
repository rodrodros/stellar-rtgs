// Display helpers. Amounts stay bigint stroops until here; times are Unix seconds of ledger
// close time, the RTGS's clock.
import { formatAmount, parseAmount } from "@rtgs/core";

/** `12345000000n` -> `"1,234.5"`. */
export function amountText(stroops: bigint, code?: string): string {
  const [whole = "", fraction] = formatAmount(stroops).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = fraction ? `${grouped}.${fraction}` : grouped;
  return code ? `${text} ${code}` : text;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function ledgerTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

/** `90061` -> `"1d 1h 1m 1s"`; seconds are dropped above an hour. */
export function duration(secs: number): string {
  const s = Math.max(0, Math.floor(Math.abs(secs)));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`, s < 3600 && `${s % 60}s`].filter(Boolean);
  return parts.length ? parts.join(" ") : "0s";
}

/** "in 5m 0s" before `target`, "5m 0s ago" after it. */
export function countdown(target: number, now: number): string {
  return now < target ? `in ${duration(target - now)}` : `${duration(now - target)} ago`;
}

export type AmountInput = { ok: true; value: bigint } | { ok: false; message: string };

/** Reads an amount typed by the user: a positive decimal with at most 7 places. */
export function readAmount(text: string): AmountInput {
  if (!text.trim()) return { ok: false, message: "Enter an amount." };
  let value: bigint;
  try {
    value = parseAmount(text);
  } catch {
    return { ok: false, message: "Enter a number with at most 7 decimal places." };
  }
  if (value <= 0n) return { ok: false, message: "The amount must be greater than zero." };
  return { ok: true, value };
}
