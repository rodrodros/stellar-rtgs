// The URL query as app state: components read it and open payment orders or transactions
// through it, so every view has a link. Opening a drawer pushes a history entry, and closing it
// goes back to the dashboard it was opened over; changing the connection replaces the current one.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatQuery, parseQuery, type ObserverQuery } from "../model/url.ts";

interface QueryContextValue {
  query: ObserverQuery;
  /** Merges `patch` into the query; `undefined` values clear a field. */
  update(patch: Partial<ObserverQuery>, opts?: { push?: boolean }): void;
  /** Closes any drawer. */
  close(): void;
}

/** What a new network invalidates: its contract and anything open from the old one. */
export const CLEAR_ON_NETWORK_CHANGE = { contract: undefined, invalidContract: undefined, payment: undefined, tx: undefined, ledger: undefined } as const;

/**
 * History state of an entry whose drawer was opened, directly or through other drawers, over a
 * dashboard entry `drawerDepth` entries back; closing goes back there.
 */
interface DrawerState {
  drawerDepth: number;
}

const depthOf = (state: unknown) => (state as Partial<DrawerState> | null)?.drawerDepth;
const hasDrawer = (q: ObserverQuery) => q.payment !== undefined || q.tx !== undefined || q.ledger !== undefined;

const QueryContext = createContext<QueryContextValue | undefined>(undefined);

export function QueryProvider(props: { children: ReactNode }) {
  const [query, setQuery] = useState(() => parseQuery(window.location.search));
  // The latest query, so `update` can write history outside React's (pure) state updater.
  const current = useRef(query);
  // Set while a close waits for its `popstate`, so a second close can't go back further.
  const closing = useRef(false);

  useEffect(() => {
    const onPop = () => {
      closing.current = false;
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
    if (opts.push) {
      const below = hasDrawer(current.current) ? depthOf(window.history.state) : 0;
      window.history.pushState(below === undefined ? null : ({ drawerDepth: below + 1 } satisfies DrawerState), "", url);
    }
    else window.history.replaceState(null, "", url);
    current.current = next;
    setQuery(next);
  }, []);

  const close = useCallback(() => {
    if (closing.current || !hasDrawer(current.current)) return;
    const depth = depthOf(window.history.state);
    if (depth) {
      closing.current = true;
      window.history.go(-depth);
    } else update({ payment: undefined, tx: undefined, ledger: undefined });
  }, [update]);

  const value = useMemo(() => ({ query, update, close }), [query, update, close]);
  return <QueryContext.Provider value={value}>{props.children}</QueryContext.Provider>;
}

export function useQuery(): QueryContextValue {
  const value = useContext(QueryContext);
  if (!value) throw new Error("useQuery outside <QueryProvider>");
  return value;
}

/** Opens and closes the payment order and transaction drawers. */
export function useNav() {
  const { update, close } = useQuery();
  return useMemo(
    () => ({
      openPayment: (id: bigint) => update({ payment: id, tx: undefined, ledger: undefined }, { push: true }),
      openTx: (hash: string) => update({ tx: hash, payment: undefined, ledger: undefined }, { push: true }),
      openLedger: (ledger: number) => update({ ledger, payment: undefined, tx: undefined }, { push: true }),
      close,
    }),
    [update, close],
  );
}
