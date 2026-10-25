import { expiresAt, type BankView, type Config, type Payment } from "@rtgs/core";
import { formatSpan } from "../model/due.ts";
import { Amount } from "./Amount.tsx";

const BLOCKED = {
  uncovered: "head not covered by the settlement balance",
  "urgent-queued": "waits for the bank's urgent queue",
} as const;

/** One bank's queues, urgent first, each in queue order (strict FIFO, ADR-0008, ADR-0009). */
export function QueueView(props: { bank: BankView; config?: Config | undefined; now?: number | undefined; nameOf(a: string): string; code?: string }) {
  const { bank } = props;
  return (
    <div className="queues">
      {(["urgent", "normal"] as const).map((priority) => {
        const queue = bank.queues[priority];
        const analysis = bank.analysis[priority];
        return (
          <div key={priority} className="queue" aria-label={`${priority} queue`}>
            <div className="queue-title">
              {priority === "urgent" ? "Urgent" : "Normal"} <span className="muted">({queue.length})</span>
              {analysis.blockedBy ? <span className="badge warn">blocked: {BLOCKED[analysis.blockedBy]}</span> : null}
            </div>
            {queue.length === 0 ? (
              <span className="muted">empty</span>
            ) : (
              <ol>
                {queue.map((p, i) => (
                  <QueueItem key={String(p.id)} payment={p} head={i === 0} {...props} />
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}

function QueueItem(props: { payment: Payment; head: boolean; config?: Config | undefined; now?: number | undefined; nameOf(a: string): string; code?: string }) {
  const { payment: p, config, now } = props;
  const left = config && now !== undefined ? expiresAt(p, config) - now : undefined;
  return (
    <li className={props.head ? "head" : undefined}>
      <span className="mono">#{String(p.id)}</span> <Amount value={p.amount} {...(props.code ? { code: props.code } : {})} /> →{" "}
      {props.nameOf(p.to)}
      {props.head ? <span className="badge">head</span> : null}
      {left !== undefined ? (
        <span className={left < 0 ? "badge warn" : "muted"}>{left < 0 ? "past expiry" : `expires in ${formatSpan(left)}`}</span>
      ) : null}
    </li>
  );
}
