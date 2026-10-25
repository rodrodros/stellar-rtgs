// Repos a keeper may act on now (ADR-0014): `convert_overdue` refuses until
// `now > opened_at + repo_term_secs`, so a repo exactly at its term is not overdue. `now` is
// ledger close time, the RTGS's clock, never the local clock. Expired payment orders come from
// core (`expirablePayments`), which applies the contract's matching rule for `expire`.
import type { Config, Repo } from "@rtgs/core";

export function termEndOf(repo: Pick<Repo, "openedAt">, config: Pick<Config, "repoTermSecs">): number {
  return repo.openedAt + config.repoTermSecs;
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
