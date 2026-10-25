// What a keeper may act on now (ADR-0014, ADR-0015). Both checks follow the contract's own
// guards: `expire` refuses until `now > submitted_at + expiry_secs`, and `convert_overdue`
// until `now > opened_at + repo_term_secs`, so a payment or repo exactly at its boundary is
// not due. `now` is ledger close time, the RTGS's clock, never the local clock.
import type { Config, Payment, Repo } from "@rtgs/core";

export function expiryOf(payment: Pick<Payment, "submittedAt">, config: Pick<Config, "expirySecs">): number {
  return payment.submittedAt + config.expirySecs;
}

export function termEndOf(repo: Pick<Repo, "openedAt">, config: Pick<Config, "repoTermSecs">): number {
  return repo.openedAt + config.repoTermSecs;
}

/** Queued payment orders whose expiry has passed, oldest first. */
export function expirablePayments(payments: Iterable<Payment>, config: Config, now: number): Payment[] {
  return [...payments]
    .filter((p) => p.status === "queued" && now > expiryOf(p, config))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Intraday repos past their term, which a keeper may turn into penalty repos. */
export function overdueRepos(repos: Iterable<Repo>, config: Config, now: number): Repo[] {
  return [...repos]
    .filter((r) => r.status === "intraday" && now > termEndOf(r, config))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

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
