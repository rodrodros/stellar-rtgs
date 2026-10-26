// Repos a keeper may act on now come from core (`overdueRepos`, `termEndOf`), as do expired
// payment orders (`expirablePayments`); both apply the contract's matching rules.
export { overdueRepos, termEndOf } from "@rtgs/core";

/** `90061` -> `"1d 1h 1m"`; negative spans read as "due". */
export function formatSpan(seconds: number): string {
  if (seconds <= 0) return "due";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`, !d && !h && s && `${s}s`].filter(Boolean);
  return parts.join(" ") || "0s";
}
