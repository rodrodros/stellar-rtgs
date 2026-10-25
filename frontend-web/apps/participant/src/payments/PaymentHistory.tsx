// The bank's outgoing and incoming payment orders with their status, newest first. The store
// holds the newest payment orders from the views plus everything the event feed has seen.
import type { PaymentRecord, PaymentStatus } from "@rtgs/core";
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

export function PaymentHistory() {
  const session = useSession();
  const { address } = useBankData();
  const payments = useSnapshot((s) => s.payments);
  const feed = useSnapshot((s) => s.feed);
  const [direction, setDirection] = useState<Direction>("all");
  const [status, setStatus] = useState<PaymentStatus | "all">("all");
  const rows = useMemo(() => filterHistory(payments.values(), address, direction, status), [payments, address, direction, status]);
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
        <p className="note">No payment orders yet.</p>
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
        Shows the newest payment orders and every event since ledger {feed.startLedger ?? "…"}.
        {feed.clamped && " Older events are beyond the RPC retention window, but their payment orders' statuses still come from the contract."}
      </p>
    </section>
  );
}
