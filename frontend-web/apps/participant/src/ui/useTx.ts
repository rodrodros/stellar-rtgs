// One flow for every write: core simulates first (a contract error surfaces before any
// signature), then signs, sends and waits for the ledger to close.
import { toRtgsError } from "@rtgs/core";
import { useCallback, useRef, useState } from "react";

export interface TxState {
  /** What is being sent, while it is. */
  pending?: string;
  /** A failure in core's words (an `RtgsError`), or an input problem. */
  error?: { title: string; detail: string };
  /** What the last successful call did. */
  done?: string;
}

export function useTx(onDone?: () => void) {
  const [state, setState] = useState<TxState>({});
  const busy = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const run = useCallback(async <T,>(label: string, work: () => Promise<T>, describe: (value: T) => string | Promise<string>) => {
    if (busy.current) return;
    busy.current = true;
    setState({ pending: label });
    try {
      const value = await work();
      setState({ done: await describe(value) });
      onDoneRef.current?.();
    } catch (e) {
      setState({ error: toRtgsError(e) });
    } finally {
      busy.current = false;
    }
  }, []);

  const fail = useCallback((title: string, detail = "") => setState({ error: { title, detail } }), []);

  return { ...state, run, fail, clear: useCallback(() => setState({}), []) };
}
