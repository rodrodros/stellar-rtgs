// The acting bank's views: custody balance, queues with their analysis, credit, and its cash
// token holding. Re-read whenever an event concerns the bank, after each of its own writes,
// and every 30 seconds as a safety net.
import type { BankView, Holding, RtgsError } from "@rtgs/core";
import { useSession, useSnapshot } from "@rtgs/core/react";
import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import { lastTouching } from "../live/touches.ts";
import { useLoad } from "./useLoad.ts";

export interface BankData {
  address: string;
  view?: BankView;
  holding?: Holding;
  error?: RtgsError;
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

export function BankDataProvider(props: { address: string; children: ReactNode }) {
  const { address } = props;
  const session = useSession();
  const config = useSnapshot((s) => s.config);
  const touched = useSnapshot((s) => lastTouching(s, address));
  const [local, refresh] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const timer = setInterval(refresh, SAFETY_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const view = useLoad(() => session.read.bank(address, config ? { config } : {}), [session, address, config, touched, local]);
  const holding = useLoad(() => session.token.holding(address), [session, address, touched, local]);

  const error = view.error ?? holding.error;
  const value: BankData = {
    address,
    loading: view.loading || holding.loading,
    refresh,
    ...(view.data ? { view: view.data } : {}),
    ...(holding.data ? { holding: holding.data } : {}),
    ...(error ? { error } : {}),
  };
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
