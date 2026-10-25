// The bank's intraday credit (ADR-0011, ADR-0014): collateral, credit outstanding, its repos
// with their terms and penalty status, and repayment. Each part follows the capability flags,
// since credit is still being implemented in the contract.
import type { Repo } from "@rtgs/core";
import { useCapabilities, useLedgerClock, useSession, useSnapshot } from "@rtgs/core/react";
import { useMemo, useState } from "react";
import { offered, STUB_NOTE } from "../session/capabilities.ts";
import { useActingBank } from "../session/ActingBank.tsx";
import { useBankData } from "../session/BankData.tsx";
import { amountText, countdown, ledgerTime, readAmount } from "../ui/format.ts";
import { TxStatus } from "../ui/TxStatus.tsx";
import { useTx } from "../ui/useTx.ts";

export function CreditPanel() {
  const session = useSession();
  const caps = useCapabilities();
  const { address, view, error } = useBankData();
  const repos = useSnapshot((s) => s.repos);
  const mine = useMemo(() => [...repos.values()].filter((r) => r.bank === address).sort((a, b) => (a.id < b.id ? 1 : -1)), [repos, address]);
  const code = session.cashToken.code;

  return (
    <section className="panel" aria-labelledby="credit-title">
      <h2 id="credit-title">Intraday credit</h2>
      {caps.credit === "stub" ? (
        <p className="note" data-testid="credit-stub">
          Credit position: {STUB_NOTE}
        </p>
      ) : view?.credit ? (
        <dl className="figures">
          <div>
            <dt>Collateral</dt>
            <dd>{amountText(view.credit.collateral, code)}</dd>
          </div>
          <div>
            <dt>Intraday repos outstanding</dt>
            <dd>{amountText(view.credit.intraday, code)}</dd>
          </div>
          <div>
            <dt>Penalty repos outstanding</dt>
            <dd className={view.credit.penalty > 0n ? "warn" : ""}>{amountText(view.credit.penalty, code)}</dd>
          </div>
        </dl>
      ) : error ? (
        <p className="tx tx-error">
          {error.title}: {error.detail}
        </p>
      ) : !view ? (
        <p className="note">Loading…</p>
      ) : (
        <p className="note">Credit position unavailable.</p>
      )}
      <h3>Repos</h3>
      {caps.repo === "stub" && mine.length === 0 ? (
        <p className="note" data-testid="repos-stub">
          Repos: {STUB_NOTE}
        </p>
      ) : mine.length === 0 ? (
        <p className="note">No repos.</p>
      ) : (
        <ul className="repos">
          {mine.map((r) => (
            <RepoItem key={String(r.id)} repo={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RepoItem({ repo }: { repo: Repo }) {
  const session = useSession();
  const caps = useCapabilities();
  const config = useSnapshot((s) => s.config);
  const { now } = useLedgerClock();
  const { actor } = useActingBank();
  const { refresh } = useBankData();
  const [amount, setAmount] = useState("");
  const tx = useTx(refresh);
  const code = session.cashToken.code;
  const due = config ? repo.openedAt + config.repoTermSecs : undefined;
  const canRepay = offered(caps.repay);

  const repay = () => {
    if (!actor) return;
    const parsed = amount.trim() ? readAmount(amount) : ({ ok: true, value: repo.outstanding } as const);
    if (!parsed.ok) return tx.fail(parsed.message);
    void tx.run(
      `Repaying ${amountText(parsed.value, code)} of repo #${repo.id}`,
      () => actor.repay(repo.id, parsed.value),
      () => {
        setAmount("");
        return `Repaid ${amountText(parsed.value, code)} of repo #${repo.id}.`;
      },
    );
  };

  return (
    <li className={`repo repo-${repo.status}`}>
      <div>
        <strong>Repo #{String(repo.id)}</strong> {amountText(repo.amount, code)}, outstanding {amountText(repo.outstanding, code)}
        <span className={`badge badge-${repo.status}`}>
          {repo.status === "penalty" ? `Penalty ${repo.rateBps / 100}%` : repo.status === "repaid" ? "Repaid" : "Intraday"}
        </span>
      </div>
      <div className="meta">
        Opened {ledgerTime(repo.openedAt)}
        {due !== undefined && repo.status === "intraday" && (
          <> · term ends {now === undefined ? ledgerTime(due) : countdown(due, now)}</>
        )}
      </div>
      {repo.status !== "repaid" && (
        <div className="row">
          <label>
            Repay ({code})
            <input inputMode="decimal" value={amount} placeholder={amountText(repo.outstanding)} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <button type="button" disabled={!actor || !canRepay || !!tx.pending} title={canRepay ? undefined : STUB_NOTE} onClick={repay}>
            Repay
          </button>
          {!canRepay && <span className="note">Repayment: {STUB_NOTE}</span>}
        </div>
      )}
      <TxStatus state={tx} />
    </li>
  );
}
