// The URL query as app state: components read it and open payment orders or transactions
// through it, so every view has a link. Opening a drawer pushes a history entry; changing the
// connection replaces the current one.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatQuery, parseQuery, type ObserverQuery } from "../model/url.ts";

interface QueryContextValue {
  query: ObserverQuery;
  /** Merges `patch` into the query; `undefined` values clear a field. */
  update(patch: Partial<ObserverQuery>, opts?: { push?: boolean }): void;
}

const QueryContext = createContext<QueryContextValue | undefined>(undefined);

export function QueryProvider(props: { children: ReactNode }) {
  const [query, setQuery] = useState(() => parseQuery(window.location.search));
  // The latest query, so `update` can write history outside React's (pure) state updater.
  const current = useRef(query);

  useEffect(() => {
    const onPop = () => {
      current.current = parseQuery(window.location.search);
      setQuery(current.current);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const update = useCallback((patch: Partial<ObserverQuery>, opts: { push?: boolean } = {}) => {
    const next = { ...current.current, ...patch };
    for (const key of Object.keys(patch) as (keyof ObserverQuery)[]) if (patch[key] === undefined) delete next[key];
    const url = `${window.location.pathname}${formatQuery(next)}${window.location.hash}`;
    if (opts.push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    current.current = next;
    setQuery(next);
  }, []);

  const value = useMemo(() => ({ query, update }), [query, update]);
  return <QueryContext.Provider value={value}>{props.children}</QueryContext.Provider>;
}

export function useQuery(): QueryContextValue {
  const value = useContext(QueryContext);
  if (!value) throw new Error("useQuery outside <QueryProvider>");
  return value;
}

/** Opens and closes the payment order and transaction drawers. */
export function useNav() {
  const { update } = useQuery();
  return useMemo(
    () => ({
      openPayment: (id: bigint) => update({ payment: id, tx: undefined, ledger: undefined }, { push: true }),
      openTx: (hash: string) => update({ tx: hash, payment: undefined, ledger: undefined }, { push: true }),
      openLedger: (ledger: number) => update({ ledger, payment: undefined, tx: undefined }, { push: true }),
      close: () => update({ payment: undefined, tx: undefined, ledger: undefined }, { push: true }),
    }),
    [update],
  );
}
