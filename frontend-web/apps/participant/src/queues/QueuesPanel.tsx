// The bank's own queues, urgent first, each in queue order (ADR-0008, ADR-0009): the head,
// what blocks it, and every queued payment order's expiry (ADR-0015).
import { expiresAt, isExpired, type Config, type Payment, type QueueAnalysis } from "@rtgs/core";
import { useCapabilities, useLedgerClock, useSession, useSnapshot } from "@rtgs/core/react";
import { QueuedActions } from "../payments/QueuedActions.tsx";
import { expiryNote, headNote } from "../payments/describe.ts";
import { useBankData } from "../session/BankData.tsx";
import { amountText, countdown, ledgerTime } from "../ui/format.ts";

export function QueuesPanel() {
  const { view, error } = useBankData();
  const config = useSnapshot((s) => s.config);
  return (
    <section className="panel wide" aria-labelledby="queues-title">
      <h2 id="queues-title">Your queues</h2>
      {!view ? (
        <p className={error ? "tx tx-error" : "note"}>{error ? `${error.title}: ${error.detail}` : "Loading…"}</p>
      ) : (
        <div className="queues">
          <Queue title="Urgent" payments={view.queues.urgent} analysis={view.analysis.urgent} balance={view.balance} config={config} />
          <Queue title="Normal" payments={view.queues.normal} analysis={view.analysis.normal} balance={view.balance} config={config} />
        </div>
      )}
    </section>
  );
}

function Queue(props: { title: string; payments: Payment[]; analysis: QueueAnalysis; balance: bigint; config?: Config }) {
  const session = useSession();
  const code = session.cashToken.code;
  const note = headNote(props.analysis, props.balance, code);
  return (
    <div className="queue" aria-label={`${props.title} queue`}>
      <h3>
        {props.title} <span className="count">{props.payments.length}</span>
      </h3>
      {props.payments.length === 0 ? (
        <p className="note">Empty.</p>
      ) : (
        <>
          {note && <p className={`head-note ${props.analysis.blockedBy ? "blocked" : ""}`}>{note}</p>}
          <ol className="queue-list">
            {props.payments.map((p, i) => (
              <li key={String(p.id)} className={i === 0 ? "head" : ""}>
                <div>
                  <strong>#{String(p.id)}</strong> to {session.registry.nameOf(p.to)}: {amountText(p.amount, code)}
                  {i === 0 && <span className="badge badge-head">Head</span>}
                </div>
                <div className="meta">
                  Submitted {ledgerTime(p.submittedAt)}
                  {props.config && <Expiry payment={p} config={props.config} />}
                </div>
                <QueuedActions payment={p} />
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function Expiry({ payment, config }: { payment: Payment; config: Config }) {
  const { now } = useLedgerClock();
  const caps = useCapabilities();
  const at = expiresAt(payment, config);
  const note = expiryNote(now !== undefined && isExpired(payment, config, now), caps.expire);
  return (
    <span className={note.past ? "expired" : ""}>
      {" · "}
      {note.text} {now === undefined ? ledgerTime(at) : countdown(at, now)}
    </span>
  );
}
