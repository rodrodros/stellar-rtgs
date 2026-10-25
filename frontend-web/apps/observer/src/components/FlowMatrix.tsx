// Liquidity flows between banks: payer rows, payee columns, shaded by amount.
import { useMemo, useState, type CSSProperties } from "react";
import { flowMatrix, useSnapshot } from "../core.ts";
import { axis, bilateralNet, cell, columnTotal, intensity, maxCell, queuedMatrix, rowTotal } from "../model/flows.ts";
import { useTruncated } from "../state/groups.ts";
import { Address, Amount } from "./format.tsx";
import { useBanks } from "./System.tsx";

type Mode = "settled" | "net" | "queued";

const MODES: { mode: Mode; label: string; note: string }[] = [
  { mode: "settled", label: "Settled", note: "Gross amounts settled in the loaded window." },
  { mode: "net", label: "Bilateral position", note: "For each pair, what the larger payer paid beyond what it received, in the loaded window." },
  { mode: "queued", label: "Queued", note: "Payment orders waiting in the queues now: where liquidity is held up." },
];

export function FlowMatrix() {
  const events = useSnapshot((s) => s.events);
  const views = useSnapshot((s) => s.banks);
  const banks = useBanks();
  const [mode, setMode] = useState<Mode>("settled");
  const truncated = useTruncated();

  const matrix = useMemo(() => {
    if (mode === "queued") return queuedMatrix(views.values());
    const settled = flowMatrix(events);
    return mode === "net" ? bilateralNet(settled) : settled;
  }, [mode, events, views]);
  const order = banks.map((b) => b.bank.address);
  const parties = axis(matrix, order);
  const max = maxCell(matrix);

  return (
    <section className="panel flows" aria-labelledby="flows-title">
      <header className="panel-header">
        <h2 id="flows-title">Liquidity flows</h2>
        <div className="segmented" role="radiogroup" aria-label="Flows shown">
          {MODES.map((m) => (
            <button key={m.mode} type="button" role="radio" aria-checked={mode === m.mode} className={mode === m.mode ? "on" : ""} onClick={() => setMode(m.mode)}>
              {m.label}
            </button>
          ))}
        </div>
      </header>
      <p className="muted">
        {MODES.find((m) => m.mode === mode)!.note}
        {truncated && mode !== "queued" && " Only the events still kept in memory count: older ones have been dropped."}
      </p>
      {parties.length === 0 ? (
        <p className="empty">No banks yet.</p>
      ) : (
        <div className="matrix-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col" className="corner">
                  payer ↓ payee →
                </th>
                {parties.map((to) => (
                  <th key={to} scope="col">
                    <Address address={to} />
                  </th>
                ))}
                <th scope="col" className="num">
                  {mode === "queued" ? "Owes" : "Paid"}
                </th>
              </tr>
            </thead>
            <tbody>
              {parties.map((from) => (
                <tr key={from}>
                  <th scope="row">
                    <Address address={from} />
                  </th>
                  {parties.map((to) => {
                    const v = cell(matrix, from, to);
                    return (
                      <td key={to} className={`num ${from === to ? "self" : ""}`} style={{ "--heat": intensity(v, max) } as CSSProperties}>
                        {v > 0n ? <Amount value={v} /> : from === to ? "" : "·"}
                      </td>
                    );
                  })}
                  <td className="num total">
                    <Amount value={rowTotal(matrix, from)} />
                  </td>
                </tr>
              ))}
              <tr className="total">
                <th scope="row">{mode === "queued" ? "Owed" : "Received"}</th>
                {parties.map((to) => (
                  <td key={to} className="num">
                    <Amount value={columnTotal(matrix, to)} />
                  </td>
                ))}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
