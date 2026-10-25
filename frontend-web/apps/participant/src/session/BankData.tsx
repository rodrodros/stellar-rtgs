// The acting bank's views: custody balance, queues with their analysis, credit, and its cash
// token holding. A bank in the registry takes its view from core's store, which re-reads it
// after every event that concerns it; an unregistered one (a wallet core doesn't know) is read
// here. The holding is always read here, since the store doesn't keep holdings. Both follow
// the events that concern the bank, debounced, and every 30 seconds as a safety net.
import type { BankView, Holding, RtgsError } from "@rtgs/core";
import { useSession, useSnapshot, useStore } from "@rtgs/core/react";
import { createContext, useCallback, useContext, useEffect, useReducer, useState, type ReactNode } from "react";
import { lastTouching } from "../live/touches.ts";
import { useLoad } from "./useLoad.ts";

export interface BankData {
  address: string;
  view?: BankView;
  holding?: Holding;
  error?: RtgsError;
  /** The view's own read failure, without the holding's. */
  viewError?: RtgsError;
  loading: boolean;
  /** Read the views again now, e.g. after a write. */
  refresh: () => void;
}

const Context = createContext<BankData | undefined>(undefined);

export function useBankData(): BankData {
  const value = useContext(Context);
  if (!value) throw new Error("useBankData outside <BankDataProvider>");
  return value;
}

export const SAFETY_REFRESH_MS = 30_000;
/** Gathers a burst of events (e.g. the replay of the retention window) into one read. */
export const EVENT_DEBOUNCE_MS = 300;

/**
 * Events that change a bank's credit position but that core's store doesn't re-read the bank
 * for (it resolves only payment-order events to banks), so this provider asks it to.
 */
const STORE_MISSES = new Set(["RepoRepaid", "RepoPenalised"] as const);

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function BankDataProvider(props: { address: string; children: ReactNode }) {
  const { address } = props;
  const session = useSession();
  const store = useStore();
  const config = useSnapshot((s) => s.config);
  const storeView = useSnapshot((s) => s.banks.get(address));
  const registered = useSnapshot((s) => s.registry.some((b) => b.address === address));
  const touched = useDebounced(
    useSnapshot((s) => lastTouching(s, address)),
    EVENT_DEBOUNCE_MS,
  );
  const missed = useSnapshot((s) => lastTouching(s, address, STORE_MISSES));
  const [local, bump] = useReducer((n: number) => n + 1, 0);

  const refresh = useCallback(() => {
    bump();
    if (registered) void store.refresh([address]);
  }, [registered, store, address]);

  useEffect(() => {
    const timer = setInterval(refresh, SAFETY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const fromStore = registered && storeView !== undefined;
  useEffect(() => {
    if (missed && fromStore) void store.refresh([address]);
  }, [missed, fromStore, store, address]);
  const direct = useLoad(
    () => (fromStore ? Promise.resolve(undefined) : session.read.bank(address, config ? { config } : {})),
    [session, address, config, fromStore, fromStore || touched, local],
  );
  const holding = useLoad(() => session.token.holding(address), [session, address, touched, local]);

  const view = fromStore ? storeView : direct.data;
  const error = (fromStore ? undefined : direct.error) ?? holding.error;
  const value: BankData = {
    address,
    loading: (!fromStore && direct.loading) || holding.loading,
    refresh,
    ...(view ? { view } : {}),
    ...(holding.data ? { holding: holding.data } : {}),
    ...(error ? { error } : {}),
    ...(!fromStore && direct.error ? { viewError: direct.error } : {}),
  };
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
