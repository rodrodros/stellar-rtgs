// Polls the simulator's status (model/simulation.ts) off the central bank's account. A data
// entry change emits no contract event, so the event feed never sees it: it is read on a timer,
// like the bank registry.
import { useEffect, useState } from "react";
import { useSession, useSnapshot, type SimStatus } from "../core.ts";
import { simView, type SimView } from "../model/simulation.ts";

export const SIM_POLL_MS = 15_000;

/** The last status read; a failed read keeps the previous one until the next poll. */
export function useSimStatus(): SimStatus | undefined {
  const session = useSession();
  const [status, setStatus] = useState<SimStatus>();
  useEffect(() => {
    let live = true;
    const read = () =>
      session.simStatus().then(
        (s) => live && setStatus(s),
        () => {},
      );
    void read();
    const timer = setInterval(read, SIM_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session]);
  return status;
}

export function useSimView(): SimView {
  const status = useSimStatus();
  const now = useSnapshot((s) => s.ledger?.closeTime);
  const lastEventAt = useSnapshot((s) => s.events.at(-1)?.closedAt);
  return simView(status, now, lastEventAt);
}
