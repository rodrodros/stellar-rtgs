// The system picture: every bank's settlement balance and queues, the central queue against its
// cap, recent settlements and offsets, the live Config, and a conservation check.
import type { FeedEvent, PaymentRecord } from "@rtgs/core";
import { useBankRegistry, useFeedStatus, useLedgerClock, useSession, useSnapshot } from "@rtgs/core/react";
import { useMemo } from "react";
import { Address } from "../components/Address.tsx";
import { Amount } from "../components/Amount.tsx";
import { QueueView } from "../components/QueueView.tsx";
import { useLedgerReads } from "../hooks/useLedgerReads.ts";
import { conservation } from "../model/conservation.ts";
import { formatSpan } from "../model/due.ts";

const VIA = { "at-once": "on submission", "eager-closure": "released by the eager closure", offset: "in an offset" } as const;

export function Overview() {
  const session = useSession();
  const snapshot = useSnapshot();
  const registry = useBankRegistry();
  const feed = useFeedStatus();
  const clock = useLedgerClock();
  const reads = useLedgerReads([], snapshot.banks);
  const code = session.cashToken.code;
  const nameOf = (a: string) => session.registry.nameOf(a);
  const { config } = snapshot;
  const banks = registry.map((b) => snapshot.banks.get(b.address)).filter((v) => v !== undefined);

  // Compared only when the holdings were read after the bank views they are checked against,
  // so a deposit between the two reads doesn't flash a false alarm.
  const comparable = snapshot.status === "ready" && banks.length === registry.length && reads.madeFor === snapshot.banks;
  const check = comparable && reads.contract ? conservation(reads.contract.balance, [...banks.map((b) => b.balance), ...reads.otherBalances]) : undefined;
  const recent = useMemo(
    () => snapshot.events.filter((e): e is Extract<FeedEvent, { type: "Settled" | "Offset" }> => e.type === "Settled" || e.type === "Offset").slice(-25).reverse(),
    [snapshot.events],
  );

  return (
    <section>
      <h2>System overview</h2>
      {snapshot.status === "loading" ? <p className="muted">Loading the views and the event history…</p> : null}
      {snapshot.error ? (
        <p className="status error" role="alert">
          {snapshot.error.title}: {snapshot.error.detail}
        </p>
      ) : null}
      <div className="tiles">
        <div className="tile" aria-label="Central queue">
          <div className="tile-label">Central queue</div>
          <div className="tile-value">
            {snapshot.queuedCount} / {config?.queueCap ?? "…"}
          </div>
          {config ? <meter min={0} max={config.queueCap} value={snapshot.queuedCount} high={config.queueCap * 0.8} /> : null}
          {config && snapshot.queuedCount >= config.queueCap ? <div className="badge danger">full: uncovered payments are refused</div> : null}
        </div>
        <div className="tile" aria-label="Conservation">
          <div className="tile-label">Conservation (S1)</div>
          {check ? (
            check.holds ? (
              <div className="tile-value ok">holds</div>
            ) : (
              <div className="tile-value danger" role="alert">
                broken by <Amount value={check.difference} code={code} />
              </div>
            )
          ) : (
            <div className="tile-value muted">…</div>
          )}
          {check ? (
            <div className="small muted">
              held <Amount value={check.held} code={code} />, recorded <Amount value={check.recorded} code={code} />
            </div>
          ) : null}
        </div>
        <div className="tile">
          <div className="tile-label">Ledger</div>
          <div className="tile-value">{clock.sequence ?? "…"}</div>
          <div className="small muted">
            {clock.closeTime ? new Date(clock.closeTime * 1000).toISOString().replace(".000Z", "Z") : null} · feed {feed.state}
          </div>
        </div>
        {config ? (
          <div className="tile" aria-label="Config">
            <div className="tile-label">Config</div>
            <dl className="small">
              <dt>queue cap</dt>
              <dd>{config.queueCap}</dd>
              <dt>expiry</dt>
              <dd>{formatSpan(config.expirySecs)}</dd>
              <dt>repo term</dt>
              <dd>{formatSpan(config.repoTermSecs)}</dd>
              <dt>penalty rate</dt>
              <dd>{config.penaltyRateBps} bps</dd>
            </dl>
          </div>
        ) : null}
      </div>

      <h3>Banks</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Bank</th>
            <th>Settlement balance</th>
            <th>Queues (head first)</th>
          </tr>
        </thead>
        <tbody>
          {banks.map((bank) => (
            <tr key={bank.address}>
              <td>
                <Address address={bank.address} name={bank.name} />
              </td>
              <td>
                <Amount value={bank.balance} code={code} />
              </td>
              <td>
                <QueueView bank={bank} config={config} now={clock.now} nameOf={nameOf} code={code} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Recent settlements and offsets</h3>
      {feed.clamped || feed.oldestLedger ? (
        <p className="small muted">Events are kept from ledger {feed.oldestLedger} on (the RPC's retention window).</p>
      ) : null}
      {recent.length === 0 ? (
        <p className="muted">None in the event window yet.</p>
      ) : (
        <ul className="events">
          {recent.map((e) =>
            e.type === "Offset" ? (
              <li key={e.eventId}>
                <span className="badge">offset</span> settled {e.ids.map((id) => `#${id}`).join(", ")} together · ledger {e.ledger}
              </li>
            ) : (
              <li key={e.eventId}>
                <span className="mono">#{String(e.id)}</span> {nameOf(e.from)} → {nameOf(e.to)} <Amount value={e.amount} code={code} />{" "}
                <span className="muted">{viaOf(snapshot.payments.get(e.id), e.eventId)} · ledger {e.ledger}</span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function viaOf(record: PaymentRecord | undefined, eventId: string): string {
  const step = record?.steps.find((s) => s.kind === "settled" && s.eventId === eventId);
  return step?.via ? `settled ${VIA[step.via]}` : "settled";
}
