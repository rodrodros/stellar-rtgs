// One sentence per event, in the glossary's terms, and one per settlement saying what released it.
import type { FeedEvent, RtgsEvent } from "../core.ts";
import { useSnapshot } from "../core.ts";
import type { Settlement } from "../model/timeline.ts";
import { Address, Amount, PaymentLink, priorityLabel } from "./format.tsx";

function useSenderOf(): (id: bigint) => string | undefined {
  const payments = useSnapshot((s) => s.payments);
  return (id) => payments.get(id)?.from;
}

function Sender(props: { id: bigint }) {
  const from = useSenderOf()(props.id);
  return from ? <Address address={from} /> : <span className="muted">the sender</span>;
}

export function EventText(props: { event: FeedEvent }) {
  const e = props.event;
  switch (e.type) {
    case "Deposited":
      return (
        <>
          <Address address={e.bank} /> deposited <Amount value={e.amount} />
        </>
      );
    case "Withdrawn":
      return (
        <>
          <Address address={e.bank} /> withdrew <Amount value={e.amount} />
        </>
      );
    case "Submitted":
      return (
        <>
          <Address address={e.from} /> submitted <PaymentLink id={e.id} />: <Amount value={e.amount} /> to <Address address={e.to} />,{" "}
          <span className={`priority priority-${e.priority}`}>{priorityLabel(e.priority).toLowerCase()}</span>
        </>
      );
    case "Settled":
      return (
        <>
          <PaymentLink id={e.id} /> settled: <Address address={e.from} /> → <Address address={e.to} /> <Amount value={e.amount} />
        </>
      );
    case "Offset":
      return (
        <>
          Offset of{" "}
          {e.ids.map((id, i) => (
            <span key={id.toString()}>
              {i > 0 && ", "}
              <PaymentLink id={id} />
            </span>
          ))}
        </>
      );
    case "Revoked":
      return (
        <>
          <Sender id={e.id} /> revoked <PaymentLink id={e.id} />
        </>
      );
    case "Reprioritised":
      return (
        <>
          <Sender id={e.id} /> moved <PaymentLink id={e.id} /> to {priorityLabel(e.priority).toLowerCase()}
        </>
      );
    case "Expired":
      return (
        <>
          <PaymentLink id={e.id} /> expired: a keeper rejected it
        </>
      );
    case "CollateralSet":
      return (
        <>
          Central bank set <Address address={e.bank} />
          {"'s"} collateral to <Amount value={e.value} />
        </>
      );
    case "RepoOpened":
      return (
        <>
          Central bank opened repo #{e.id.toString()} for <Address address={e.bank} />: <Amount value={e.amount} />
        </>
      );
    case "RepoRepaid":
      return (
        <>
          Repo #{e.id.toString()}: <Amount value={e.amount} /> repaid, <Amount value={e.outstanding} /> outstanding
        </>
      );
    case "RepoPenalised":
      return (
        <>
          Repo #{e.id.toString()} became a penalty repo at {(e.rateBps / 100).toFixed(2)}%
        </>
      );
    case "Token":
      return (
        <>
          Cash token {e.action}
          {e.from && (
            <>
              {" "}
              from <Address address={e.from} />
            </>
          )}
          {e.to && (
            <>
              {" "}
              to <Address address={e.to} />
            </>
          )}
          {e.amount !== undefined && (
            <>
              {" "}
              <Amount value={e.amount} />
            </>
          )}
          {e.authorized !== undefined && <> ({e.authorized ? "authorized" : "deauthorized"})</>}
        </>
      );
    case "Unknown":
      return <>Unrecognised contract event{e.name ? ` "${e.name}"` : ""}</>;
  }
}

/** What the trigger did, as the object of "released by …". */
export function TriggerText(props: { trigger: RtgsEvent }) {
  const t = props.trigger;
  switch (t.type) {
    case "Deposited":
      return (
        <>
          <Address address={t.bank} />
          {"'s"} deposit of <Amount value={t.amount} />
        </>
      );
    case "Revoked":
      return (
        <>
          the revocation of <PaymentLink id={t.id} />, which unblocked the queue
        </>
      );
    case "Reprioritised":
      return (
        <>
          moving <PaymentLink id={t.id} /> to {priorityLabel(t.priority).toLowerCase()}
        </>
      );
    case "Expired":
      return (
        <>
          the expiry of <PaymentLink id={t.id} />, which unblocked the queue
        </>
      );
    case "Submitted":
      return (
        <>
          the submission of <PaymentLink id={t.id} />
        </>
      );
    default:
      return <>{t.type}</>;
  }
}

/** How one settlement came about. */
export function SettlementCause(props: { settlement: Settlement; trigger: RtgsEvent | undefined }) {
  const { settlement: s, trigger } = props;
  if (s.via === "at-once") return <span className="cause cause-at-once">settled at once on submission</span>;
  if (s.via === "offset") return <span className="cause cause-offset">settled in an offset</span>;
  return (
    <span className="cause cause-eager">
      settled by the eager closure after{" "}
      {s.releasedBy?.kind === "payment" ? (
        <>
          <PaymentLink id={s.releasedBy.id} /> credited <Address address={s.event.from} />
        </>
      ) : trigger ? (
        <TriggerText trigger={trigger} />
      ) : (
        "an earlier action in the same transaction"
      )}
    </span>
  );
}
