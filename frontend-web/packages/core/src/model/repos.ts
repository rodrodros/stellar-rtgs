// Repos a keeper may act on now (ADR-0014): `convert_overdue` refuses until
// `now > opened_at + repo_term_secs`, so a repo exactly at its term is not overdue. `now` is
// ledger close time, the RTGS's clock, never the local clock.
import type { Config, Repo } from "../types.ts";

export function termEndOf(repo: Pick<Repo, "openedAt">, config: Pick<Config, "repoTermSecs">): number {
  return repo.openedAt + config.repoTermSecs;
}

/** Intraday repos past their term, which a keeper may turn into penalty repos, oldest first. */
export function overdueRepos(repos: Iterable<Repo>, config: Config, now: number): Repo[] {
  return [...repos]
    .filter((r) => r.status === "intraday" && now > termEndOf(r, config))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
