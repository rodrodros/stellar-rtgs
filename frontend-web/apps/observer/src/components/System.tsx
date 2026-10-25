// The system picture: every bank's settlement balance and queues, the central queue against
// its cap, and credit where the contract implements it.
import { useMemo } from "react";
import { useLedgerClock, useSnapshot, type Bank, type BankView, type Capabilities, type Payment, type Priority } from "../core.ts";
import { expiryOf, formatDuration } from "../model/expiry.ts";
import { Address, Amount, PaymentLink, priorityLabel } from "./format.tsx";

/** The registry's banks by name, each with its current view (undefined until it is read). */
export function useBanks(): { bank: Bank; view: BankView | undefined }[] {
  const registry = useSnapshot((s) => s.registry);
  const views = useSnapshot((s) => s.banks);
  return useMemo(
    () =>
      [...registry]
        .sort((a, b) => (a.name ?? a.address).localeCompare(b.name ?? b.address, undefined, { numeric: true }))
        .map((bank) => ({ bank, view: views.get(bank.address) })),
    [registry, views],
  );
}

export const creditImplemented = (caps: Capabilities) => caps.credit === "available";

function HeadStatus(props: { view: BankView }) {
  const { urgent, normal } = props.view.analysis;
  const blocked = [urgent, normal].find((q) => q.blockedBy);
  if (!blocked) return <span className="status status-rest">at rest</span>;
  if (blocked.blockedBy === "urgent-queued") return <span className="status status-blocked">normal queue held back by urgent</span>;
  const short = (blocked.head?.amount ?? 0n) - props.view.balance;
  return (
    <span className="status status-blocked">
      {priorityLabel(blocked.priority).toLowerCase()} head blocked: needs <Amount value={short} /> more
    </span>
  );
}

export function BanksTable() {
  const banks = useBanks();
  const caps = useSnapshot((s) => s.capabilities);
  const credit = creditImplemented(caps);
  return (
    <section className="panel banks" aria-labelledby="banks-title">
      <header className="panel-header">
        <h2 id="banks-title">Participants</h2>
        <span className="muted">{banks.length} banks</span>
      </header>
      {banks.length === 0 ? (
        <p className="empty">No banks known yet: none in config, none registered by the central bank, and none seen in events.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Bank</th>
              <th scope="col" className="num">
                Settlement balance
              </th>
              <th scope="col" className="num">
                Urgent
              </th>
              <th scope="col" className="num">
                Normal
              </th>
              <th scope="col">Queue heads</th>
              {credit && (
                <>
                  <th scope="col" className="num">
                    Intraday credit
                  </th>
                  <th scope="col" className="num">
                    Penalty repos
                  </th>
                  <th scope="col" className="num">
                    Collateral
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {banks.map(({ bank, view }) => (
              <tr key={bank.address}>
                <th scope="row">
                  <Address address={bank.address} />
                </th>
                <td className="num">{view ? <Amount value={view.balance} /> : "…"}</td>
                <td className="num">{view ? view.queues.urgent.length : "…"}</td>
                <td className="num">{view ? view.queues.normal.length : "…"}</td>
                <td>{view ? <HeadStatus view={view} /> : "…"}</td>
                {credit && (
                  <>
                    <td className="num">{view?.credit ? <Amount value={view.credit.intraday} /> : "…"}</td>
                    <td className="num">{view?.credit ? <Amount value={view.credit.penalty} /> : "…"}</td>
                    <td className="num">{view?.credit ? <Amount value={view.credit.collateral} /> : "…"}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function QueueGauge() {
  const queued = useSnapshot((s) => s.queuedCount);
  const config = useSnapshot((s) => s.config);
  const cap = config?.queueCap;
  const ratio = cap ? Math.min(1, queued / cap) : 0;
  return (
    <section className="panel gauge" aria-labelledby="gauge-title">
      <header className="panel-header">
        <h2 id="gauge-title">Central queue</h2>
      </header>
      <div className="gauge-figure">
        <span className="gauge-value">{queued}</span>
        <span className="muted"> / {cap ?? "…"} queued</span>
      </div>
      <div
        className={`gauge-bar ${ratio >= 1 ? "full" : ratio >= 0.75 ? "high" : ""}`}
        role="meter"
        aria-label="Payment orders queued against the queue cap"
        aria-valuemin={0}
        {...(cap ? { "aria-valuemax": cap } : {})}
        aria-valuenow={queued}
      >
        <span style={{ width: `${ratio * 100}%` }} />
      </div>
      {ratio >= 1 && <p className="warn">The queue cap is reached: a payment order that would queue is refused.</p>}
      {config && (
        <dl className="config">
          <dt>Expiry</dt>
          <dd>{formatDuration(config.expirySecs)} after submission</dd>
          <dt>Repo term</dt>
          <dd>{formatDuration(config.repoTermSecs)}</dd>
          <dt>Penalty rate</dt>
          <dd>{(config.penaltyRateBps / 100).toFixed(2)}%</dd>
        </dl>
      )}
    </section>
  );
}

function ExpiryText(props: { payment: Payment; now: number | undefined }) {
  const config = useSnapshot((s) => s.config);
  const caps = useSnapshot((s) => s.capabilities);
  const expiry = expiryOf(props.payment, config, props.now);
  if (expiry.kind === "unknown") return null;
  if (expiry.kind === "running") return <span className="expiry">expires in {formatDuration(expiry.secondsLeft)}</span>;
  return (
    <span className="expiry passed">
      {caps.expire === "available" ? "past expiry: a keeper may reject it" : "past expiry (expiry not implemented in this contract yet)"}
    </span>
  );
}

function Lane(props: { view: BankView; priority: Priority; now: number | undefined }) {
  const { view, priority, now } = props;
  const queue = view.queues[priority];
  const analysis = view.analysis[priority];
  return (
    <div className={`lane lane-${priority}`}>
      <span className={`lane-label priority-${priority}`}>{priorityLabel(priority)}</span>
      {queue.length === 0 ? (
        <span className="muted lane-empty">empty</span>
      ) : (
        <ol className="chips">
          {queue.map((p, i) => (
            <li key={p.id.toString()} className={`chip ${i === 0 ? "head" : ""} ${i === 0 && analysis.blockedBy ? "blocked" : ""}`}>
              <PaymentLink id={p.id} /> <Amount value={p.amount} /> → <Address address={p.to} />
              {i === 0 && analysis.blockedBy === "uncovered" && (
                <span className="why">
                  uncovered: needs <Amount value={p.amount - view.balance} /> more
                </span>
              )}
              {i === 0 && analysis.blockedBy === "urgent-queued" && <span className="why">held back by the urgent queue</span>}
              <ExpiryText payment={p} now={now} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function QueueLanes() {
  const banks = useBanks().filter(({ view }) => view && view.queues.urgent.length + view.queues.normal.length > 0);
  // One clock for every countdown on the panel.
  const { now } = useLedgerClock();
  return (
    <section className="panel queues" aria-labelledby="queues-title">
      <header className="panel-header">
        <h2 id="queues-title">Queues</h2>
        <span className="muted">queue order: urgent first, then strict FIFO within each priority class</span>
      </header>
      {banks.length === 0 ? (
        <p className="empty">Every queue is empty: the system is at rest.</p>
      ) : (
        banks.map(({ bank, view }) => (
          <div key={bank.address} className="bank-queues">
            <h3>
              <Address address={bank.address} /> <span className="muted">balance</span> <Amount value={view!.balance} />
            </h3>
            <Lane view={view!} priority="urgent" now={now} />
            <Lane view={view!} priority="normal" now={now} />
          </div>
        ))
      )}
    </section>
  );
}

const LABELS: Record<string, string> = {
  expire: "expiry",
  setCollateral: "collateral",
  openRepo: "repos",
  repay: "repayment",
  convertOverdue: "penalty conversion",
  credit: "credit view",
  repo: "repo view",
};

/** Which entry points the deployed contract still stubs. */
export function CapabilityNote() {
  const caps = useSnapshot((s) => s.capabilities);
  const stubs = Object.entries(caps).filter(([, c]) => c === "stub").map(([name]) => LABELS[name] ?? name);
  const unknown = Object.entries(caps).filter(([, c]) => c === "unknown").map(([name]) => LABELS[name] ?? name);
  if (!stubs.length && !unknown.length) return null;
  return (
    <p className="capabilities muted">
      {stubs.length > 0 && <>Not implemented in this contract yet: {stubs.join(", ")}. </>}
      {unknown.length > 0 && <>Couldn't tell whether these are implemented: {unknown.join(", ")}.</>}
    </p>
  );
}

export function CreditPanel() {
  const caps = useSnapshot((s) => s.capabilities);
  const repos = useSnapshot((s) => s.repos);
  const collateral = useSnapshot((s) => s.collateral);
  const shown = caps.credit === "available" || caps.repo === "available" || repos.size > 0 || collateral.size > 0;
  if (!shown) {
    return (
      <section className="panel credit" aria-labelledby="credit-title">
        <header className="panel-header">
          <h2 id="credit-title">Credit</h2>
        </header>
        <p className="empty">Credit (intraday repos) is not implemented in this contract yet.</p>
      </section>
    );
  }
  const list = [...repos.values()].sort((a, b) => Number(b.id - a.id));
  return (
    <section className="panel credit" aria-labelledby="credit-title">
      <header className="panel-header">
        <h2 id="credit-title">Credit</h2>
        <span className="muted">{list.filter((r) => r.status !== "repaid").length} repos open</span>
      </header>
      {list.length === 0 ? (
        <p className="empty">No repos seen.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Repo</th>
              <th scope="col">Bank</th>
              <th scope="col" className="num">
                Amount
              </th>
              <th scope="col" className="num">
                Outstanding
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id.toString()}>
                <th scope="row">#{r.id.toString()}</th>
                <td>
                  <Address address={r.bank} />
                </td>
                <td className="num">
                  <Amount value={r.amount} />
                </td>
                <td className="num">
                  <Amount value={r.outstanding} />
                </td>
                <td className={`status status-${r.status}`}>
                  {r.status === "penalty" ? `penalty, ${(r.rateBps / 100).toFixed(2)}%` : r.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {caps.credit !== "available" && collateral.size > 0 && (
        <p className="muted">
          Collateral set:{" "}
          {[...collateral].map(([bank, value], i) => (
            <span key={bank}>
              {i > 0 && ", "}
              <Address address={bank} /> <Amount value={value} />
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
