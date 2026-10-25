// Revoke (ADR-0016) and reprioritise (ADR-0009) for one of the bank's queued payment orders.
// The outcome lives above the rows: a revoked order leaves the queue and a reprioritised one
// moves to the other, so a row's own state would vanish with it. Each panel shows the outcome
// of the actions taken in it.
import type { Payment } from "@rtgs/core";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useActingBank } from "../session/ActingBank.tsx";
import { useBankData } from "../session/BankData.tsx";
import { TxStatus } from "../ui/TxStatus.tsx";
import { useTx } from "../ui/useTx.ts";

type Origin = "queues" | "history";

interface Actions {
  tx: ReturnType<typeof useTx>;
  origin?: Origin;
  setOrigin: (origin: Origin) => void;
}

const Context = createContext<Actions | undefined>(undefined);

export function QueuedActionsProvider({ children }: { children: ReactNode }) {
  const { refresh } = useBankData();
  const tx = useTx(refresh);
  const [origin, setOrigin] = useState<Origin>();
  return <Context.Provider value={{ tx, ...(origin ? { origin } : {}), setOrigin }}>{children}</Context.Provider>;
}

function useActions(): Actions {
  const value = useContext(Context);
  if (!value) throw new Error("QueuedActions outside <QueuedActionsProvider>");
  return value;
}

/** The outcome of the last revocation or reprioritisation taken in this panel. */
export function ActionOutcome({ origin }: { origin: Origin }) {
  const { tx, origin: last } = useActions();
  return last === origin ? <TxStatus state={tx} /> : null;
}

export function QueuedActions({ payment, origin }: { payment: Payment; origin: Origin }) {
  const { actor } = useActingBank();
  const { tx, setOrigin } = useActions();
  const act = useCallback(
    (label: string, work: () => Promise<unknown>, done: string) => {
      setOrigin(origin);
      void tx.run(label, work, () => done);
    },
    [origin, setOrigin, tx],
  );
  if (!actor || payment.status !== "queued" || payment.from !== actor.address) return null;
  const other = payment.priority === "urgent" ? "normal" : "urgent";
  return (
    <span className="actions">
      <button
        type="button"
        disabled={!!tx.pending}
        onClick={() => act(`Moving #${payment.id} to ${other}`, () => actor.reprioritise(payment.id, other), `#${payment.id} is now ${other}.`)}
      >
        Make {other}
      </button>
      <button
        type="button"
        className="danger"
        disabled={!!tx.pending}
        onClick={() => act(`Revoking #${payment.id}`, () => actor.revoke(payment.id), `#${payment.id} revoked.`)}
      >
        Revoke
      </button>
    </span>
  );
}
