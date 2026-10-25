// Two drawers over the dashboard: one payment order's lifecycle, and one transaction's events.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toRtgsError, useLedgerClock, useSession, useSnapshot, type LifecycleStep, type Payment, type PaymentRecord, type RtgsError } from "../core.ts";
import { expiryOf, formatDuration } from "../model/expiry.ts";
import { explainSettlements, groupByTransaction } from "../model/timeline.ts";
import { useNav } from "../state/query.tsx";
import { SettlementCause } from "./EventText.tsx";
import { Address, Amount, priorityLabel, Time, TxLink } from "./format.tsx";
import { TxEvents } from "./Timeline.tsx";

function Drawer(props: { title: ReactNode; label: string; children: ReactNode }) {
  const nav = useNav();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && nav.close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);
  return (
    <div className="drawer-backdrop" onClick={nav.close}>
      <aside className="drawer" role="dialog" aria-label={props.label} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <h2>{props.title}</h2>
          <button type="button" className="close" aria-label="Close" onClick={nav.close}>
            ×
          </button>
        </header>
        {props.children}
      </aside>
    </div>
  );
}

const STEP_LABEL: Record<LifecycleStep["kind"], string> = {
  submitted: "Submitted",
  reprioritised: "Reprioritised",
  settled: "Settled (final)",
  revoked: "Revoked",
  expired: "Expired",
};

/** A settled step's cause, from its transaction's events when they are loaded, else from core's summary. */
function StepCause(props: { step: LifecycleStep }) {
  const { step } = props;
  const events = useSnapshot((s) => s.events);
  const explained = useMemo(() => {
    const group = groupByTransaction(events.filter((e) => e.txHash === step.txHash))[0];
    if (!group) return undefined;
    const settlement = explainSettlements(group.events).find((s) => s.event.eventId === step.eventId);
    return settlement && { settlement, trigger: group.trigger };
  }, [events, step]);
  if (explained) return <SettlementCause settlement={explained.settlement} trigger={explained.trigger} />;
  if (step.via === "at-once") return <span className="cause">settled at once on submission</span>;
  if (step.via === "offset") return <span className="cause">settled in an offset</span>;
  return <span className="cause">settled by the eager closure{step.trigger ? ` after a ${step.trigger.type} event` : ""}</span>;
}

function QueuePlace(props: { payment: Payment }) {
  const { payment } = props;
  const view = useSnapshot((s) => s.banks.get(payment.from));
  const config = useSnapshot((s) => s.config);
  const caps = useSnapshot((s) => s.capabilities);
  const { now } = useLedgerClock();
  if (!view) return null;
  const queue = view.queues[payment.priority];
  const index = queue.findIndex((p) => p.id === payment.id);
  const analysis = view.analysis[payment.priority];
  const expiry = expiryOf(payment, config, now);
  return (
    <div className="queue-place">
      {index < 0 ? (
        <p className="muted">Not in its sender's queue in the latest read; it is about to change.</p>
      ) : (
        <p>
          {index === 0 ? "Head" : `Position ${index + 1}`} of {queue.length} in <Address address={payment.from} />
          {"'s"} {priorityLabel(payment.priority).toLowerCase()} queue.{" "}
          {index === 0 && analysis.blockedBy === "uncovered" && (
            <>
              Blocked: the settlement balance (<Amount value={view.balance} />) doesn't cover it.
            </>
          )}
          {index === 0 && analysis.blockedBy === "urgent-queued" && <>Held back: the sender has urgent payment orders queued.</>}
          {index > 0 && <>Waits for the payment orders ahead of it (strict FIFO).</>}
        </p>
      )}
      {expiry.kind === "running" && <p>Expires in {formatDuration(expiry.secondsLeft)}.</p>}
      {expiry.kind === "passed" && (
        <p className="warn">
          Its expiry passed {formatDuration(expiry.secondsAgo)} ago.{" "}
          {caps.expire === "available" ? "A keeper may reject it now." : "Expiry is not implemented in this contract yet."}
        </p>
      )}
    </div>
  );
}

function Lifecycle(props: { record: PaymentRecord }) {
  const { record } = props;
  const feed = useSnapshot((s) => s.feed);
  const sawSubmission = record.steps.some((s) => s.kind === "submitted");
  return (
    <>
      {!sawSubmission && (
        <p className="note">
          Submitted before the loaded window
          {feed.startLedger !== undefined ? ` (which starts at ledger ${feed.startLedger.toLocaleString()})` : ""}, so its earlier events aren't
          loaded. Its status comes from the contract.
        </p>
      )}
      <ol className="lifecycle">
        {record.steps.map((step) => (
          <li key={step.eventId} className={`step step-${step.kind}`}>
            <span className="step-kind">{STEP_LABEL[step.kind]}</span>
            {step.kind === "reprioritised" && step.priority && <> to {priorityLabel(step.priority).toLowerCase()}</>}
            {step.kind === "settled" && (
              <>
                {" — "}
                <StepCause step={step} />
              </>
            )}
            <div className="step-meta">
              <Time at={step.closedAt} withDate /> · <TxLink hash={step.txHash} ledger={step.ledger} />
            </div>
          </li>
        ))}
        {record.status === "queued" && <li className="step step-waiting">Queued: waiting for cover</li>}
      </ol>
    </>
  );
}

export function PaymentDrawer(props: { id: bigint }) {
  const { id } = props;
  const session = useSession();
  const record = useSnapshot((s) => s.payments.get(id));
  const [fetched, setFetched] = useState<{ id: bigint; payment: Payment | null; error?: RtgsError }>();

  useEffect(() => {
    if (record) return;
    let cancelled = false;
    session.read.payment(id).then(
      (payment) => !cancelled && setFetched({ id, payment: payment ?? null }),
      (e) => !cancelled && setFetched({ id, payment: null, error: toRtgsError(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [id, record, session]);

  const shown: PaymentRecord | undefined = record ?? (fetched?.id === id && fetched.payment ? { ...fetched.payment, steps: [] } : undefined);
  const title = <>Payment order #{id.toString()}</>;

  if (!shown) {
    const lookup = fetched?.id === id ? fetched : undefined;
    return (
      <Drawer title={title} label={`Payment order ${id}`}>
        {!lookup && <p className="muted">Reading the payment order…</p>}
        {lookup?.error && (
          <p className="error">
            {lookup.error.title}: {lookup.error.detail}
          </p>
        )}
        {lookup && !lookup.error && <p className="empty">No payment order has this id.</p>}
      </Drawer>
    );
  }

  return (
    <Drawer title={title} label={`Payment order ${id}`}>
      <dl className="summary">
        <dt>From</dt>
        <dd>
          <Address address={shown.from} />
        </dd>
        <dt>To</dt>
        <dd>
          <Address address={shown.to} />
        </dd>
        <dt>Amount</dt>
        <dd>
          <Amount value={shown.amount} />
        </dd>
        <dt>Priority class</dt>
        <dd className={`priority priority-${shown.priority}`}>{priorityLabel(shown.priority)}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`badge badge-${shown.status}`}>{shown.status}</span>
        </dd>
        <dt>Submitted</dt>
        <dd>
          <Time at={shown.submittedAt} withDate />
        </dd>
        {shown.settledAt !== undefined && (
          <>
            <dt>Settled</dt>
            <dd>
              <Time at={shown.settledAt} withDate />
            </dd>
          </>
        )}
      </dl>
      {shown.status === "queued" && <QueuePlace payment={shown} />}
      <h3>Lifecycle</h3>
      <Lifecycle record={shown} />
    </Drawer>
  );
}

export function TxDrawer(props: { hash: string }) {
  const events = useSnapshot((s) => s.events);
  const group = useMemo(() => groupByTransaction(events.filter((e) => e.txHash === props.hash))[0], [events, props.hash]);
  return (
    <Drawer title={<>Transaction</>} label="Transaction">
      <p className="mono break">{props.hash}</p>
      {group ? (
        <>
          <p>
            Ledger {group.ledger.toLocaleString()}, closed <Time at={group.closedAt} withDate />. Final at the close of this ledger (ADR-0005).
          </p>
          <TxEvents group={group} showToken />
        </>
      ) : (
        <p className="empty">This transaction's events aren't in the loaded window.</p>
      )}
    </Drawer>
  );
}
