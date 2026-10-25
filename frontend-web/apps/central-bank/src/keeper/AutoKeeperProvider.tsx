// The auto-keeper lives above the pages, so it keeps running while the browser tab is open,
// whichever page is showing. It is mounted per network, contract and signer (see App), so a
// switch of any of them resets it to off.
import { useCapabilities, useStore } from "@rtgs/core/react";
import { toRtgsError } from "@rtgs/core";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { firstReason } from "../components/capability.ts";
import { expirablePayments, overdueRepos } from "../model/due.ts";
import { useRole } from "../session/role.ts";
import { useWriteQueue } from "../session/writeQueue.ts";
import { AutoKeeper, type KeeperResult } from "./autoKeeper.ts";

export const AUTO_KEEPER_INTERVAL_MS = 10_000;

export interface AutoKeeperControl {
  enabled: boolean;
  setEnabled(on: boolean): void;
  /** Why it can't be switched on, if it can't. */
  disabledReason?: string | undefined;
  /** What it did, newest first. */
  log: readonly string[];
}

const Context = createContext<AutoKeeperControl | undefined>(undefined);

export function AutoKeeperProvider(props: { children: ReactNode; intervalMs?: number }) {
  const caps = useCapabilities();
  const role = useRole();
  const store = useStore();
  const queue = useWriteQueue();
  const [enabled, setEnabled] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const actor = role.actor;
  const disabledReason = firstReason(
    !actor && "Connect a signer first",
    caps.expire === "stub" && caps.convertOverdue === "stub" && "Both keeper entry points are stubs",
  );
  const on = enabled && !disabledReason;
  const intervalMs = props.intervalMs ?? AUTO_KEEPER_INTERVAL_MS;

  useEffect(() => {
    if (!on || !actor) return;
    const keeper = new AutoKeeper({
      due: () => {
        const s = store.getSnapshot();
        if (!s.config || !s.ledger) return { payments: [], repos: [] };
        return {
          payments: caps.expire === "stub" ? [] : expirablePayments(s.payments.values(), s.config, s.ledger.closeTime).map((p) => p.id),
          repos: caps.convertOverdue === "stub" ? [] : overdueRepos(s.repos.values(), s.config, s.ledger.closeTime).map((r) => r.id),
        };
      },
      // Through the signer's write queue, so it never races a button on the same account.
      expire: (id) => queue.run(() => actor.expire(id)),
      convertOverdue: (id) => queue.run(() => actor.convertOverdue(id)),
      onResult: (r) => setLog((l) => [describe(r), ...l].slice(0, 20)),
    });
    keeper.start();
    void keeper.tick();
    const timer = setInterval(() => void keeper.tick(), intervalMs);
    return () => {
      keeper.stop();
      clearInterval(timer);
    };
  }, [on, actor, store, caps, queue, intervalMs]);

  const value = useMemo(() => ({ enabled: on, setEnabled, disabledReason, log }), [on, disabledReason, log]);
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useAutoKeeper(): AutoKeeperControl {
  const value = useContext(Context);
  if (!value) throw new Error("useAutoKeeper outside <AutoKeeperProvider>");
  return value;
}

function describe(r: KeeperResult): string {
  switch (r.kind) {
    case "expired":
      return `expired payment order #${r.id}`;
    case "converted":
      return `converted repo #${r.id} to a penalty repo`;
    case "failed":
      return `${r.action} #${r.id} failed: ${toRtgsError(r.error).title}`;
  }
}
