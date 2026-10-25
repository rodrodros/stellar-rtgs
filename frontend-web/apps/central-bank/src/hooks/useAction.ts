import { toRtgsError, type RtgsError } from "@rtgs/core";
import { useCallback, useEffect, useRef, useState } from "react";

export interface ActionState {
  /** The label of the action in flight. */
  pending?: string;
  error?: { label: string; error: RtgsError };
  done?: { label: string; txHash?: string; ledger?: number };
}

/**
 * Runs one write at a time and keeps its outcome for <ActionStatus>. Every failure comes out
 * through core's error mapping, in the glossary's terms.
 */
export function useAction() {
  const [state, setState] = useState<ActionState>({});
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const run = useCallback(async <T,>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
    setState({ pending: label });
    try {
      const value = await work();
      const outcome = value && typeof value === "object" ? (value as { txHash?: unknown; ledger?: unknown }) : {};
      const done: ActionState["done"] = { label };
      if (typeof outcome.txHash === "string") done.txHash = outcome.txHash;
      if (typeof outcome.ledger === "number") done.ledger = outcome.ledger;
      if (mounted.current) setState({ done });
      return value;
    } catch (e) {
      if (mounted.current) setState({ error: { label, error: toRtgsError(e) } });
      return undefined;
    }
  }, []);

  return { state, run, busy: state.pending !== undefined };
}
