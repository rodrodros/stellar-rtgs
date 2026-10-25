// The bank's outgoing and incoming payment orders with their status, newest first. The store
// holds the newest payment orders system-wide (from the views) plus everything the event feed
// has seen; "Load older" pages further back through the views, which outlive the RPC's
// retention window.
import { toRtgsError, type Payment, type PaymentRecord, type PaymentStatus, type RtgsError } from "@rtgs/core";
import { useSession, useSnapshot } from "@rtgs/core/react";
import { useMemo, useState } from "react";
import { useBankData } from "../session/BankData.tsx";
import { amountText, ledgerTime } from "../ui/format.ts";
import { PriorityBadge, StatusBadge } from "../ui/StatusBadge.tsx";
import { QueuedActions } from "./QueuedActions.tsx";
import { settledVia } from "./describe.ts";

type Direction = "all" | "outgoing" | "incoming";

export function filterHistory(
  payments: Iterable<PaymentRecord>,
  bank: string,
  direction: Direction,
  status: PaymentStatus | "all",
): PaymentRecord[] {
  const rows: PaymentRecord[] = [];
  for (const p of payments) {
    const out = p.from === bank;
    const inc = p.to === bank;
    if (!out && !inc) continue;
    if (direction === "outgoing" && !out) continue;
    if (direction === "incoming" && !inc) continue;
    if (status !== "all" && p.status !== status) continue;
    rows.push(p);
  }
  return rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** How many payment ids "Load older" reads per click. */
export const OLDER_PAGE = 100n;

/**
 * The lowest id of the unbroken run of ids down from the newest one: every payment order from
 * it up is known. The store holds more than the newest payment orders (old queued ones, and
 * old ones its events mention), so its smallest id says nothing about the gaps above it.
 */
export function contiguousFrom(known: ReadonlySet<bigint>): bigint | undefined {
  let newest: bigint | undefined;
  for (const id of known) if (newest === undefined || id > newest) newest = id;
  if (newest === undefined) return undefined;
  let lowest = newest;
  while (lowest > 0n && known.has(lowest - 1n)) lowest -= 1n;
  return lowest;
}

/** The store's payment orders, plus older ones read on demand; the store's are fresher. */
export function withOlder(store: ReadonlyMap<bigint, PaymentRecord>, older: ReadonlyMap<bigint, Payment>): PaymentRecord[] {
  const merged = new Map<bigint, PaymentRecord>();
  for (const [id, p] of older) merged.set(id, { ...p, steps: [] });
  for (const [id, p] of store) merged.set(id, p);
  return [...merged.values()];
}

export function PaymentHistory() {
  const session = useSession();
  const { address } = useBankData();
  const payments = useSnapshot((s) => s.payments);
  const feed = useSnapshot((s) => s.feed);
  const storeStatus = useSnapshot((s) => s.status);
  const loading = storeStatus === "loading";
  const [direction, setDirection] = useState<Direction>("all");
  const [status, setStatus] = useState<PaymentStatus | "all">("all");
  const [older, setOlder] = useState<ReadonlyMap<bigint, Payment>>(new Map());
  const [paging, setPaging] = useState<{ busy: boolean; error?: RtgsError }>({ busy: false });
  // Every id "Load older" has read, including ids the views no longer return (archived).
  const [scanned, setScanned] = useState<ReadonlySet<bigint>>(new Set());
  const all = useMemo(() => withOlder(payments, older), [payments, older]);
  const rows = useMemo(() => filterHistory(all, address, direction, status), [all, address, direction, status]);
  const lowest = useMemo(() => contiguousFrom(new Set([...all.map((p) => p.id), ...scanned])), [all, scanned]);

  const loadOlder = async () => {
    if (lowest === undefined || lowest === 0n) return;
    const to = lowest - 1n;
    const from = to + 1n > OLDER_PAGE ? to + 1n - OLDER_PAGE : 0n;
    setPaging({ busy: true });
    try {
      const page = await session.read.payments({ from, to });
      setOlder((prev) => {
        const next = new Map(prev);
        for (const p of page) next.set(p.id, p);
        return next;
      });
      setScanned((prev) => {
        const next = new Set(prev);
        for (let id = from; id <= to; id++) next.add(id);
        return next;
      });
      setPaging({ busy: false });
    } catch (e) {
      setPaging({ busy: false, error: toRtgsError(e) });
    }
  };
  const code = session.cashToken.code;
  const name = (a: string) => session.registry.nameOf(a);

  return (
    <section className="panel wide" aria-labelledby="history-title">
      <h2 id="history-title">Payment orders</h2>
      <div className="row filters">
        <label>
          Direction
          <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="all">All</option>
            <option value="outgoing">Outgoing</option>
            <option value="incoming">Incoming</option>
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as PaymentStatus | "all")}>
            <option value="all">All</option>
            <option value="queued">Queued</option>
            <option value="settled">Settled</option>
            <option value="revoked">Revoked</option>
            <option value="expired">Expired</option>
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="note">
          {loading ? "Loading payment orders…" : storeStatus === "error" ? "Payment orders couldn't be loaded; reconnect above." : "No payment orders found."}
        </p>
      ) : (
        <table className="history">
          <thead>
            <tr>
              <th>Id</th>
              <th>Counterparty</th>
              <th className="num">Amount</th>
              <th>Priority</th>
              <th>Status</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const out = p.from === address;
              const via = p.status === "settled" ? settledVia(p, name) : undefined;
              return (
                <tr key={String(p.id)} data-testid={`payment-${p.id}`}>
                  <td>#{String(p.id)}</td>
                  <td>{out ? `To ${name(p.to)}` : `From ${name(p.from)}`}</td>
                  <td className={`num ${out ? "out" : "in"}`}>
                    {out ? "−" : "+"}
                    {amountText(p.amount, code)}
                  </td>
                  <td>
                    <PriorityBadge priority={p.priority} />
                  </td>
                  <td>
                    <StatusBadge status={p.status} />
                    {via && <span className="meta"> {via}</span>}
                  </td>
                  <td className="meta">{ledgerTime(p.settledAt ?? p.submittedAt)}</td>
                  <td>{out && <QueuedActions payment={p} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="note">
        Shows the newest payment orders across the system
        {lowest !== undefined && lowest > 0n ? ` (back to #${lowest})` : ""} and every event since ledger {feed.startLedger ?? "…"}.
        {feed.clamped && " Older events are beyond the RPC retention window; older payment orders still load from the contract."}
      </p>
      {storeStatus === "ready" && lowest !== undefined && lowest > 0n && (
        <button type="button" disabled={paging.busy} onClick={() => void loadOlder()}>
          {paging.busy ? "Loading…" : "Load older payment orders"}
        </button>
      )}
      {paging.error && (
        <p className="tx tx-error" role="alert">
          <strong>{paging.error.title}</strong> {paging.error.detail}
        </p>
      )}
    </section>
  );
}
