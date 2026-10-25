// The loaded events grouped by transaction, shared by the timeline and the drawers.
import { useMemo } from "react";
import { STORE_EVENT_LIMIT, useSnapshot } from "../core.ts";
import { groupByTransaction, type TxGroup } from "../model/timeline.ts";

/** Whether the store has dropped older events: it keeps the newest `STORE_EVENT_LIMIT`. */
export function useTruncated(): boolean {
  return useSnapshot((s) => s.events.length >= STORE_EVENT_LIMIT);
}

export function useTxGroups(): TxGroup[] {
  const events = useSnapshot((s) => s.events);
  const truncated = useTruncated();
  return useMemo(() => groupByTransaction(events, { truncated }), [events, truncated]);
}
