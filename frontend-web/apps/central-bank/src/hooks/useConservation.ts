// The conservation check (S1) from outside the contract: the cash it holds against every
// settlement balance it records. The two can't be read atomically, so a read that straddles a
// deposit or withdrawal can differ for a moment. A mismatch is therefore read again before it
// is reported, and only one that persists counts.
import { toRtgsError, type RtgsError, type RtgsSession } from "@rtgs/core";
import { useBankRegistry, useSession, useSnapshot } from "@rtgs/core/react";
import { useEffect, useState } from "react";
import { conservation, type Conservation } from "../model/conservation.ts";

export const RECHECK_MS = 1500;

/** One read of what the contract holds and records, for the registry's banks plus the central bank and the contract itself. */
export async function readConservation(session: RtgsSession, banks: readonly string[]): Promise<Conservation> {
  const accounts = [...banks, session.centralBank, session.contractId];
  const [held, balances] = await Promise.all([
    session.token.holding(session.contractId),
    Promise.all(accounts.map((a) => session.read.balance(a))),
  ]);
  return conservation(held.balance, balances);
}

/** Reads, and on a mismatch waits and reads again: only a mismatch both reads see is reported. */
export async function checkConservation(read: () => Promise<Conservation>, wait: () => Promise<void>): Promise<Conservation> {
  const first = await read();
  if (first.holds) return first;
  await wait();
  return read();
}

export function useConservation(): { result?: Conservation; error?: RtgsError } {
  const session = useSession();
  const banks = useBankRegistry();
  const lastEvent = useSnapshot((s) => s.events.at(-1)?.eventId);
  const ready = useSnapshot((s) => s.status === "ready");
  const [state, setState] = useState<{ result?: Conservation; error?: RtgsError }>({});
  const key = banks.map((b) => b.address).join(",");

  useEffect(() => {
    // Until the registry and the views have loaded, the list of accounts may be incomplete.
    if (!ready) return;
    let cancelled = false;
    const list = key ? key.split(",") : [];
    checkConservation(
      () => readConservation(session, list),
      () => new Promise((r) => setTimeout(r, RECHECK_MS)),
    ).then(
      (result) => !cancelled && setState({ result }),
      // A failed read leaves no result: an old "holds" must not stand for the current state.
      (e) => !cancelled && setState({ error: toRtgsError(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [session, key, lastEvent, ready]);

  return state;
}
