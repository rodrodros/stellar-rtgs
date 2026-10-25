// Revoke (ADR-0016) and reprioritise (ADR-0009) for one of the bank's queued payment orders.
import type { Payment } from "@rtgs/core";
import { useActingBank } from "../session/ActingBank.tsx";
import { useBankData } from "../session/BankData.tsx";
import { TxStatus } from "../ui/TxStatus.tsx";
import { useTx } from "../ui/useTx.ts";

export function QueuedActions({ payment }: { payment: Payment }) {
  const { actor } = useActingBank();
  const { refresh } = useBankData();
  const tx = useTx(refresh);
  if (!actor || payment.status !== "queued" || payment.from !== actor.address) return null;
  const other = payment.priority === "urgent" ? "normal" : "urgent";
  return (
    <span className="actions">
      <button
        type="button"
        disabled={!!tx.pending}
        onClick={() =>
          void tx.run(`Moving #${payment.id} to ${other}`, () => actor.reprioritise(payment.id, other), () => `#${payment.id} is now ${other}.`)
        }
      >
        Make {other}
      </button>
      <button
        type="button"
        className="danger"
        disabled={!!tx.pending}
        onClick={() => void tx.run(`Revoking #${payment.id}`, () => actor.revoke(payment.id), () => `#${payment.id} revoked.`)}
      >
        Revoke
      </button>
      <TxStatus state={tx} />
    </span>
  );
}
