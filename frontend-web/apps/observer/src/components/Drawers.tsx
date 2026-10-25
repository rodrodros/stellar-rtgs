// Drawers over the dashboard: one payment order's lifecycle, one transaction's events, and every
// loaded transaction of one ledger.
import { useEffect, useState, type ReactNode } from "react";
import { ledgerUrl, toRtgsError, txUrl, useLedgerClock, useSession, useSnapshot, type LifecycleStep, type Payment, type PaymentRecord, type RtgsError } from "../core.ts";
import { expiryOf, formatDuration } from "../model/expiry.ts";
import type { TxGroup } from "../model/timeline.ts";
import { useTxGroups } from "../state/groups.ts";
import { useNav } from "../state/query.tsx";
import { SettlementCause } from "./EventText.tsx";
import { Address, Amount, ExplorerLink, priorityLabel, Time, TxLink } from "./format.tsx";
import { EXPIRE_NOTE } from "./System.tsx";
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
function StepCause(props: { step: LifecycleStep; groups: TxGroup[] }) {
  const { step } = props;
  const group = props.groups.find((g) => g.txHash === step.txHash);
  const settlement = group?.settlements.find((s) => s.event.eventId === step.eventId);
  if (group && settlement) return <SettlementCause settlement={settlement} trigger={group.trigger} />;
  if (step.via === "at-once") return <span className="cause">settled at once on submission</span>;
  if (step.via === "offset") return <span className="cause">settled in an offset</span>;
  return (
    <span className="cause">
      settled by the eager closure{step.trigger ? ` after ${TRIGGER_WORDS[step.trigger.type] ?? "an earlier action"} in the same transaction` : ""}
    </span>
  );
}

/** Core's trigger types in words, for a step whose transaction's events are no longer loaded. */
const TRIGGER_WORDS: Partial<Record<string, string>> = {
  Deposited: "a deposit",
  Submitted: "a submission",
  Revoked: "a revocation",
  Reprioritised: "a reprioritisation",
  Expired: "an expiry",
};

function QueuePlace(props: { payment: Payment }) {
  const { payment } = props;
  const view = useSnapshot((s) => s.banks.get(payment.from));
  const config = useSnapshot((s) => s.config);
  const caps = useSnapshot((s) => s.capabilities);
  const { closeTime: now } = useLedgerClock();
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
          {index === 0 ? "Head" : `Number ${index + 1} in queue order`} of {queue.length} in <Address address={payment.from} />
          {"'s"} {priorityLabel(payment.priority).toLowerCase()} queue.{" "}
          {index === 0 && analysis.blockedBy === "uncovered" && (
            <>
              Uncovered: the settlement balance (<Amount value={view.balance} />) doesn't cover it.
            </>
          )}
          {index === 0 && analysis.blockedBy === "urgent-queued" && <>Held back: the sender has urgent payment orders queued.</>}
          {index > 0 && <>Waits for the payment orders ahead of it (strict FIFO).</>}
        </p>
      )}
      {expiry.kind === "running" && <p>Expires in {formatDuration(expiry.secondsLeft)}.</p>}
      {expiry.kind === "passed" && (
        <p className="warn">
          Its expiry passed {formatDuration(expiry.secondsAgo)} ago{EXPIRE_NOTE[caps.expire]}.
        </p>
      )}
    </div>
  );
}

function Lifecycle(props: { record: PaymentRecord }) {
  const { record } = props;
  const feed = useSnapshot((s) => s.feed);
  const groups = useTxGroups();
  const sawSubmission = record.steps.some((s) => s.kind === "submitted");
  return (
    <>
      {!sawSubmission && (
        <p className="note">
          {feed.state === "backfilling"
            ? "Older events are still loading, so its submission may not be shown yet."
            : `Submitted before the loaded events${feed.startLedger !== undefined ? `, which start at ledger ${feed.startLedger.toLocaleString()}` : ""}, so its submission isn't shown.`}{" "}
          Its status comes from the contract.
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
                <StepCause step={step} groups={groups} />
              </>
            )}
            <div className="step-meta">
              <Time at={step.closedAt} withDate /> · <TxLink hash={step.txHash} ledger={step.ledger} />
            </div>
          </li>
        ))}
        {record.status === "queued" && <li className="step step-waiting">Queued: not settled yet</li>}
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
        {shown.partial ? <dd className="muted">reading…</dd> : <dd className={`priority priority-${shown.priority}`}>{priorityLabel(shown.priority)}</dd>}
        <dt>Status</dt>
        <dd>
          <span className={`badge badge-${shown.status}`}>{shown.status}</span>
        </dd>
        <dt>Submitted</dt>
        <dd>{shown.partial ? <span className="muted">reading…</span> : <Time at={shown.submittedAt} withDate />}</dd>
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
  const session = useSession();
  const group = useTxGroups().find((g) => g.txHash === props.hash);
  return (
    <Drawer title={<>Transaction</>} label="Transaction">
      <p className="mono break">{props.hash}</p>
      <p>
        <ExplorerLink href={txUrl(session.network, props.hash)}>Open on the {session.network.label} explorer</ExplorerLink>
      </p>
      {group ? (
        <>
          <p>
            Ledger {group.ledger.toLocaleString()}, closed <Time at={group.closedAt} withDate />. A payment order it settled was final when this
            ledger closed (ADR-0005).
          </p>
          <TxEvents group={group} showToken />
        </>
      ) : (
        <p className="empty">This transaction's events aren't among the loaded events.</p>
      )}
    </Drawer>
  );
}

export function LedgerDrawer(props: { ledger: number }) {
  const groups = useTxGroups().filter((g) => g.ledger === props.ledger);
  const nav = useNav();
  const session = useSession();
  return (
    <Drawer title={<>Ledger {props.ledger.toLocaleString()}</>} label={`Ledger ${props.ledger}`}>
      <p>
        <ExplorerLink href={ledgerUrl(session.network, props.ledger)}>Open on the {session.network.label} explorer</ExplorerLink>
      </p>
      {groups.length === 0 ? (
        <p className="empty">None of the loaded events is in this ledger.</p>
      ) : (
        <>
          <p>
            Closed <Time at={groups[0]!.closedAt} withDate />. {groups.length} transaction{groups.length === 1 ? "" : "s"} touched the settlement
            contract or its cash token.
          </p>
          {groups.map((g) => (
            <div key={g.txHash} className="tx-group">
              <div className="tx-head">
                <button type="button" className="link mono" title={g.txHash} onClick={() => nav.openTx(g.txHash)}>
                  tx {g.txHash.slice(0, 8)}…
                </button>
              </div>
              <TxEvents group={g} showToken />
            </div>
          ))}
        </>
      )}
    </Drawer>
  );
}
