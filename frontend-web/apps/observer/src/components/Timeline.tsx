// The live timeline: the loaded events, grouped by transaction, newest first. Each settlement
// says what released it. Filters by kind of event and by bank.
import { useMemo, useState } from "react";
import { useSnapshot } from "../core.ts";
import { categoryOf, filterGroups, type Category, type TxGroup } from "../model/timeline.ts";
import { useTxGroups } from "../state/groups.ts";
import { EventText, SettlementCause } from "./EventText.tsx";
import { Time, TxLink, useNameOf } from "./format.tsx";

const FILTERS: { category: Category; label: string }[] = [
  { category: "liquidity", label: "Deposits & withdrawals" },
  { category: "payments", label: "Payment orders" },
  { category: "credit", label: "Collateral & repos" },
  { category: "token", label: "Cash token" },
];

const PAGE = 100;

export function TxEvents(props: { group: TxGroup; showToken: boolean }) {
  const { group, showToken } = props;
  const byEvent = new Map(group.settlements.map((s) => [s.event.eventId, s]));
  return (
    <ul className="tx-events">
      {group.events
        .filter((e) => showToken || e.type !== "Token")
        .map((e) => {
          const settlement = byEvent.get(e.eventId);
          return (
            <li key={e.eventId} className={`event event-${categoryOf(e)} event-${e.type.toLowerCase()}`}>
              <span className="event-type">{e.type === "Token" ? `token:${e.action}` : e.type}</span>
              <span className="event-text">
                <EventText event={e} />
                {settlement && (
                  <>
                    {" — "}
                    <SettlementCause settlement={settlement} trigger={group.trigger} />
                  </>
                )}
              </span>
            </li>
          );
        })}
    </ul>
  );
}

export function Timeline() {
  const events = useSnapshot((s) => s.events);
  const payments = useSnapshot((s) => s.payments);
  const registry = useSnapshot((s) => s.registry);
  const nameOf = useNameOf();
  const [categories, setCategories] = useState<ReadonlySet<Category>>(() => new Set<Category>(["liquidity", "payments", "credit", "other"]));
  const [bank, setBank] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const groups = useTxGroups();
  const shown = useMemo(() => {
    const senderOf = (id: bigint) => payments.get(id)?.from;
    return filterGroups(groups, { categories, ...(bank ? { bank } : {}) }, senderOf).reverse();
  }, [groups, categories, bank, payments]);

  const toggle = (c: Category) =>
    setCategories((current) => {
      const next = new Set(current);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  return (
    <section className="panel timeline" aria-labelledby="timeline-title">
      <header className="panel-header">
        <h2 id="timeline-title">Timeline</h2>
        <span className="muted">{shown.length.toLocaleString()} transactions</span>
      </header>
      <div className="filters">
        {FILTERS.map((f) => (
          <label key={f.category} className={`chip-toggle ${categories.has(f.category) ? "on" : ""}`}>
            <input type="checkbox" checked={categories.has(f.category)} onChange={() => toggle(f.category)} />
            {f.label}
          </label>
        ))}
        <select aria-label="Bank" value={bank} onChange={(e) => setBank(e.target.value)}>
          <option value="">All banks</option>
          {registry.map((b) => (
            <option key={b.address} value={b.address}>
              {nameOf(b.address)}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="empty">{events.length ? "No transactions match these filters." : "No events in the loaded window yet."}</p>
      ) : (
        <ol className="tx-list">
          {shown.slice(0, limit).map((g) => (
            <li key={g.txHash} className="tx-group">
              <div className="tx-head">
                <Time at={g.closedAt} /> <TxLink hash={g.txHash} ledger={g.ledger} />
              </div>
              <TxEvents group={g} showToken={categories.has("token")} />
            </li>
          ))}
        </ol>
      )}
      {shown.length > limit && (
        <button type="button" className="more" onClick={() => setLimit((n) => n + PAGE)}>
          Show older transactions
        </button>
      )}
    </section>
  );
}
