// @rtgs/core/react: thin hooks over the framework-agnostic session and store. No UI.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Capabilities } from "../capabilities.ts";
import { toRtgsError, type RtgsError } from "../errors.ts";
import type { FeedStatus } from "../events/feed.ts";
import type { RtgsStore, StoreOptions, SystemSnapshot } from "../model/store.ts";
import type { NetworkConfig } from "../network/networks.ts";
import type { Bank } from "../registry/banks.ts";
import { connect, type ConnectOptions, type RtgsSession } from "../session.ts";
import type { FeedEvent } from "../types.ts";

interface RtgsContextValue {
  session: RtgsSession;
  store: RtgsStore;
}

const RtgsContext = createContext<RtgsContextValue | undefined>(undefined);

/**
 * Connects to `network` and reconnects when it (or the options) change, disposing the old
 * session first, so nothing bound to the old network outlives the switch. `key` changes force a
 * reconnect (e.g. after a devnet bootstrap).
 */
export function useConnection(network: NetworkConfig | undefined, options: ConnectOptions = {}, key?: unknown) {
  const [state, setState] = useState<{ session?: RtgsSession; connecting: boolean; error?: RtgsError }>({ connecting: !!network });
  const [attempt, setAttempt] = useState(0);
  const optionsKey = JSON.stringify({ contractId: options.contractId, ack: options.acknowledgeMainnet });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!network) {
      setState({ connecting: false });
      return;
    }
    let cancelled = false;
    let session: RtgsSession | undefined;
    setState({ connecting: true });
    connect(network, optionsRef.current).then(
      (s) => {
        session = s;
        if (cancelled) s.dispose();
        else setState({ session: s, connecting: false });
      },
      (e) => {
        if (!cancelled) setState({ connecting: false, error: toRtgsError(e) });
      },
    );
    return () => {
      cancelled = true;
      session?.dispose();
    };
  }, [network, optionsKey, key, attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reconnect };
}

/** Shares one session and its store with the tree below. Renders `fallback` without a session. */
export function RtgsProvider(props: { session: RtgsSession | undefined; storeOptions?: StoreOptions; fallback?: ReactNode; children: ReactNode }) {
  const { session, storeOptions } = props;
  const [value, setValue] = useState<RtgsContextValue>();
  useEffect(() => {
    if (!session) {
      setValue(undefined);
      return;
    }
    const { store, release } = session.store(storeOptions);
    setValue({ session, store });
    return release;
    // The store options apply when the store is created; changing them later has no effect.
  }, [session]);
  if (!value || value.session !== session) return <>{props.fallback ?? null}</>;
  return <RtgsContext.Provider value={value}>{props.children}</RtgsContext.Provider>;
}

function useRtgs(): RtgsContextValue {
  const value = useContext(RtgsContext);
  if (!value) throw new Error("@rtgs/core/react: use these hooks inside <RtgsProvider> with a session");
  return value;
}

export function useSession(): RtgsSession {
  return useRtgs().session;
}

export function useStore(): RtgsStore {
  return useRtgs().store;
}

/**
 * Subscribes to the system snapshot. `selector` must return a value from the snapshot (or a
 * primitive), not a new object on every call; derive objects with `useMemo` instead.
 */
export function useSnapshot(): SystemSnapshot;
export function useSnapshot<T>(selector: (snapshot: SystemSnapshot) => T): T;
export function useSnapshot<T>(selector?: (snapshot: SystemSnapshot) => T): T | SystemSnapshot {
  const store = useStore();
  const get = () => (selector ? selector(store.getSnapshot()) : store.getSnapshot());
  return useSyncExternalStore(store.subscribe, get, get);
}

export function useCapabilities(): Capabilities {
  return useSession().capabilities;
}

export function useFeedStatus(): FeedStatus {
  return useSnapshot((s) => s.feed);
}

/** The recent events, optionally filtered; oldest first. */
export function useEvents(filter?: (event: FeedEvent) => boolean): readonly FeedEvent[] {
  const events = useSnapshot((s) => s.events);
  return useMemo(() => (filter ? events.filter(filter) : events), [events, filter]);
}

export function useBankRegistry(): readonly Bank[] {
  return useSnapshot((s) => s.registry);
}

/**
 * The RTGS clock: the latest ledger's close time, advanced by the local clock between ledgers
 * so countdowns (expiry, repo terms) tick smoothly. Updates every `tickMs`.
 */
export function useLedgerClock(tickMs = 1000): { sequence?: number; closeTime?: number; now?: number } {
  const ledger = useSnapshot((s) => s.ledger);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [, setTick] = useState(0);
  useEffect(() => setReceivedAt(Date.now()), [ledger]);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  if (!ledger) return {};
  return { sequence: ledger.sequence, closeTime: ledger.closeTime, now: ledger.closeTime + Math.floor((Date.now() - receivedAt) / 1000) };
}
