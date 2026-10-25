// Reads the store doesn't keep: cash token holdings (trustlines and the contract's SAC
// balance). They are re-read whenever the event feed brings something new, which includes the
// cash token's own events.
import { toRtgsError, type Holding, type RtgsError } from "@rtgs/core";
import { useSession, useSnapshot } from "@rtgs/core/react";
import { useCallback, useEffect, useState } from "react";

export interface LedgerReads {
  holdings: ReadonlyMap<string, Holding>;
  /** The settlement contract's own cash token holding. */
  contract?: Holding;
  error?: RtgsError;
  reload(): void;
}

export function useLedgerReads(addresses: readonly string[]): LedgerReads {
  const session = useSession();
  // A new event (of either contract) is the cue to re-read.
  const lastEvent = useSnapshot((s) => s.events.at(-1)?.eventId);
  const [state, setState] = useState<Omit<LedgerReads, "reload">>({ holdings: new Map() });
  const [epoch, setEpoch] = useState(0);
  const key = addresses.join(",");

  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split(",") : [];
    (async () => {
      try {
        const [contract, holdings] = await Promise.all([
          session.token.holding(session.contractId),
          Promise.all(list.map(async (a) => [a, await session.token.holding(a)] as const)),
        ]);
        if (!cancelled) setState({ contract, holdings: new Map(holdings) });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: toRtgsError(e) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, key, lastEvent, epoch]);

  const reload = useCallback(() => setEpoch((n) => n + 1), []);
  return { ...state, reload };
}
