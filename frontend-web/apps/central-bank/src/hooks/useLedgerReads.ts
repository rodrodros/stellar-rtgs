// Reads the store doesn't keep: cash token holdings (trustlines and the contract's SAC
// balance) and the settlement balances of accounts that aren't banks. They are re-read whenever
// the event feed brings something new, which includes the cash token's own events.
import { toRtgsError, type Holding, type RtgsError } from "@rtgs/core";
import { useSession, useSnapshot } from "@rtgs/core/react";
import { useCallback, useEffect, useState } from "react";

export interface LedgerReads {
  holdings: ReadonlyMap<string, Holding>;
  /** The settlement contract's own cash token holding. */
  contract?: Holding;
  /** Settlement balances recorded for the central bank and the contract itself, which aren't banks. */
  otherBalances: bigint[];
  error?: RtgsError;
  /** The `refreshOn` value these reads were made for. */
  madeFor?: unknown;
  reload(): void;
}

/** `refreshOn`: re-read whenever it changes, e.g. the store's bank views. */
export function useLedgerReads(addresses: readonly string[], refreshOn?: unknown): LedgerReads {
  const session = useSession();
  // A new event (of either contract) is the cue to re-read.
  const lastEvent = useSnapshot((s) => s.events.at(-1)?.eventId);
  const [state, setState] = useState<Omit<LedgerReads, "reload">>({ holdings: new Map(), otherBalances: [] });
  const [epoch, setEpoch] = useState(0);
  const key = addresses.join(",");

  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split(",") : [];
    (async () => {
      try {
        const [contract, holdings, cbBalance, selfBalance] = await Promise.all([
          session.token.holding(session.contractId),
          Promise.all(list.map(async (a) => [a, await session.token.holding(a)] as const)),
          session.read.balance(session.centralBank),
          session.read.balance(session.contractId),
        ]);
        if (!cancelled) setState({ contract, holdings: new Map(holdings), otherBalances: [cbBalance, selfBalance], madeFor: refreshOn });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: toRtgsError(e) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, key, lastEvent, epoch, refreshOn]);

  const reload = useCallback(() => setEpoch((n) => n + 1), []);
  return { ...state, reload };
}
