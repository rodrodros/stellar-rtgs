import { toRtgsError, type RtgsError } from "@rtgs/core";
import { useEffect, useRef, useState } from "react";

/**
 * Runs `load` whenever `deps` change. The last data stays on screen while a reload runs, and
 * a response that arrives after a newer request started is dropped.
 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): { data?: T; error?: RtgsError; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: RtgsError; loading: boolean }>({ loading: true });
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => {
        if (id === request.current) setState({ data, loading: false });
      },
      (e) => {
        if (id === request.current) setState((s) => ({ ...s, error: toRtgsError(e), loading: false }));
      },
    );
    // `load` is a fresh closure every render; `deps` say when it means something new.
  }, deps);
  return state;
}
