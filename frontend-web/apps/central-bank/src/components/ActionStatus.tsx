import type { ActionState } from "../hooks/useAction.ts";
import { LedgerLink, TxLink } from "./TxLink.tsx";

export function ActionStatus(props: { state: ActionState }) {
  const { pending, error, done } = props.state;
  if (pending) return <p className="status pending">{pending}…</p>;
  if (error)
    return (
      <p className="status error" role="alert">
        <strong>
          {error.label}: {error.error.title}
        </strong>{" "}
        {error.error.detail}
      </p>
    );
  if (done)
    return (
      <p className="status ok">
        {done.label}: done
        {done.txHash ? (
          <>
            {" "}
            in transaction <TxLink hash={done.txHash} />
          </>
        ) : null}
        {done.ledger !== undefined ? (
          <>
            , <LedgerLink ledger={done.ledger} />
          </>
        ) : null}
      </p>
    );
  return null;
}
