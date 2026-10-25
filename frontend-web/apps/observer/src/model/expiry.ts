// A queued payment order's expiry (ADR-0015), on the RTGS's clock: the latest ledger's close
// time. Core analyses only each queue's head; the observer shows every queued payment order's.
import { expiresAt, type Config, type Payment } from "../core.ts";

export type Expiry =
  | { kind: "unknown" }
  | { kind: "running"; at: number; secondsLeft: number }
  | { kind: "passed"; at: number; secondsAgo: number };

export function expiryOf(payment: Payment, config: Config | undefined, now: number | undefined): Expiry {
  if (!config || now === undefined) return { kind: "unknown" };
  const at = expiresAt(payment, config);
  return now >= at ? { kind: "passed", at, secondsAgo: now - at } : { kind: "running", at, secondsLeft: at - now };
}

/** `90061` -> `"1 d 1 h"`, `3720` -> `"1 h 2 min"`, `45` -> `"45 s"`: the two largest units. */
export function formatDuration(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  const i = UNITS.findIndex(([, size]) => secs >= size);
  if (i < 0) return "0 s";
  const [name, size] = UNITS[i]!;
  const parts = [`${Math.floor(secs / size)} ${name}`];
  const next = UNITS[i + 1];
  const rest = next ? Math.floor((secs % size) / next[1]) : 0;
  if (next && rest > 0) parts.push(`${rest} ${next[0]}`);
  return parts.join(" ");
}

const UNITS: readonly [string, number][] = [
  ["d", 86_400],
  ["h", 3_600],
  ["min", 60],
  ["s", 1],
];
