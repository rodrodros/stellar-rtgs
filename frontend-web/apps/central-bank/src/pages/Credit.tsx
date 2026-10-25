// Intraday credit as collateralised repos (ADR-0011, ADR-0014). Everything here is gated on
// the deployed contract's capabilities: while the credit entry points are stubs, the page
// shows what it would do but nothing can be sent.
import { parseAmount, type BankView, type Repo } from "@rtgs/core";
import { useBankRegistry, useCapabilities, useFeedStatus, useLedgerClock, useSession, useSnapshot } from "@rtgs/core/react";
import { useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { ActionStatus } from "../components/ActionStatus.tsx";
import { Address } from "../components/Address.tsx";
import { Amount } from "../components/Amount.tsx";
import { capabilityReason, firstReason } from "../components/capability.ts";
import { useAction } from "../hooks/useAction.ts";
import { formatSpan, overdueRepos, termEndOf } from "../model/due.ts";
import { centralBankReason, useRole } from "../session/role.ts";

const CREDIT_ENTRY_POINTS = ["setCollateral", "openRepo", "repay", "convertOverdue", "credit", "repo"] as const;

function parsePositive(text: string, allowZero = false): bigint | undefined {
  try {
    const v = parseAmount(text);
    return v > 0n || (allowZero && v === 0n) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function Credit() {
  const caps = useCapabilities();
  const registry = useBankRegistry();
  const banks = useSnapshot((s) => s.banks);
  const repos = useSnapshot((s) => s.repos);
  const feed = useFeedStatus();
  const stubbed = CREDIT_ENTRY_POINTS.filter((e) => caps[e] === "stub");

  return (
    <section>
      <h2>Intraday credit</h2>
      {stubbed.length === CREDIT_ENTRY_POINTS.length ? (
        <p className="status warn" role="status">
          The deployed settlement contract doesn't implement credit yet: collateral, repos and repayment are all stubs. This page
          enables each action as soon as the contract does.
        </p>
      ) : stubbed.length ? (
        <p className="status warn" role="status">
          Not implemented by this contract yet: {stubbed.join(", ")}.
        </p>
      ) : null}
      <p className="muted">
        A repo mints cash into the settlement contract and credits the bank's settlement balance, up to its collateral (S21). An
        unpaid repo becomes a penalty repo once its term has passed; a keeper converts it, and the penalty rate is recorded, not
        charged.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Bank</th>
            <th>Collateral</th>
            <th>Intraday credit</th>
            <th>Penalty repos</th>
            <th>Headroom</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {registry.map((b) => (
            <CreditRow key={b.address} address={b.address} name={b.name} view={banks.get(b.address)} />
          ))}
        </tbody>
      </table>

      <h3>Repos</h3>
      {caps.repo !== "available" && feed.oldestLedger ? (
        <p className="small muted">
          Repos come from RepoOpened events, which the RPC keeps from ledger {feed.oldestLedger} on. Older repos need the repo view.
        </p>
      ) : null}
      <RepoTable repos={[...repos.values()]} />
    </section>
  );
}

function CreditRow(props: { address: string; name: string | undefined; view: BankView | undefined }) {
  const session = useSession();
  const caps = useCapabilities();
  const role = useRole();
  const collateralSeen = useSnapshot((s) => s.collateral.get(props.address));
  const action = useAction();
  const [collateral, setCollateral] = useState("");
  const [repo, setRepo] = useState("");
  const code = session.cashToken.code;
  const credit = props.view?.credit;
  const headroom = credit ? credit.collateral - credit.intraday - credit.penalty : undefined;
  const cb = role.centralBank;
  const base = firstReason(centralBankReason(role), action.busy && "Busy");
  const collateralValue = parsePositive(collateral, true);
  const repoValue = parsePositive(repo);
  const label = props.name ?? "the bank";

  return (
    <tr>
      <td>
        <Address address={props.address} name={props.name} />
      </td>
      <td>
        <Amount value={credit?.collateral ?? collateralSeen} code={code} />
      </td>
      <td>
        <Amount value={credit?.intraday} code={code} />
      </td>
      <td>
        <Amount value={credit?.penalty} code={code} />
      </td>
      <td>
        <Amount value={headroom} code={code} />
      </td>
      <td className="actions">
        <input aria-label={`Collateral for ${label}`} placeholder="Collateral value" value={collateral} onChange={(e) => setCollateral(e.target.value)} />
        <ActionButton
          disabledReason={firstReason(capabilityReason(caps, "setCollateral"), base, collateral && collateralValue === undefined && "Enter a value of zero or more")}
          disabled={!collateral}
          onClick={() => void action.run(`Set ${label}'s collateral`, () => cb!.setCollateral(props.address, collateralValue!))}
        >
          Set collateral
        </ActionButton>
        <input aria-label={`Repo amount for ${label}`} placeholder="Repo amount" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <ActionButton
          disabledReason={firstReason(
            capabilityReason(caps, "openRepo"),
            base,
            repo && repoValue === undefined && "Enter an amount above zero",
            repoValue !== undefined && headroom !== undefined && repoValue > headroom && "More than the collateral's headroom",
          )}
          disabled={!repo}
          onClick={() => void action.run(`Open a repo for ${label}`, () => cb!.openRepo(props.address, repoValue!))}
        >
          Open repo
        </ActionButton>
        <ActionStatus state={action.state} />
      </td>
    </tr>
  );
}

export function RepoTable(props: { repos: Repo[] }) {
  const session = useSession();
  const config = useSnapshot((s) => s.config);
  // The countdown ticks with the ledger clock; "overdue" follows the latest closed ledger, as
  // the Keeper page does, so the two never disagree.
  const clock = useLedgerClock();
  const closeTime = useSnapshot((s) => s.ledger?.closeTime);
  const sorted = [...props.repos].sort((a, b) => (a.id < b.id ? 1 : -1));
  if (!sorted.length) return <p className="muted">No repos.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Repo</th>
          <th>Bank</th>
          <th>Amount</th>
          <th>Outstanding</th>
          <th>Opened</th>
          <th>Term</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <RepoRow
            key={String(r.id)}
            repo={r}
            termEnd={config ? termEndOf(r, config) : undefined}
            now={clock.now}
            closeTime={closeTime}
            code={session.cashToken.code}
          />
        ))}
      </tbody>
    </table>
  );
}

function RepoRow(props: { repo: Repo; termEnd: number | undefined; now: number | undefined; closeTime: number | undefined; code: string }) {
  const { repo: r, termEnd, now, closeTime } = props;
  const session = useSession();
  const caps = useCapabilities();
  const role = useRole();
  const config = useSnapshot((s) => s.config);
  const action = useAction();
  const [amount, setAmount] = useState("");
  const left = termEnd !== undefined && now !== undefined ? termEnd - now : undefined;
  // The contract converts only strictly after the term ends (SC-A20-02): the same rule as the keeper's.
  const overdue = !!config && closeTime !== undefined && overdueRepos([r], config, closeTime).length > 0;
  const value = parsePositive(amount);
  const busy = action.busy && "Busy";

  return (
    <tr className={r.status === "penalty" ? "highlight" : undefined}>
      <td className="mono">#{String(r.id)}</td>
      <td>
        <Address address={r.bank} name={session.registry.get(r.bank)?.name} />
      </td>
      <td>
        <Amount value={r.amount} code={props.code} />
      </td>
      <td>
        <Amount value={r.outstanding} code={props.code} />
      </td>
      <td>{new Date(r.openedAt * 1000).toISOString().replace(".000Z", "Z")}</td>
      <td>{r.status !== "intraday" ? "—" : overdue ? <span className="badge warn">overdue</span> : left !== undefined ? `ends in ${formatSpan(left)}` : "—"}</td>
      <td>
        <span className={r.status === "penalty" ? "badge danger" : r.status === "repaid" ? "badge ok" : "badge"}>
          {r.status}
          {r.status === "penalty" ? ` · ${r.rateBps} bps` : ""}
        </span>
      </td>
      <td className="actions">
        {r.status !== "repaid" ? (
          <>
            <input aria-label={`Repay amount for repo ${r.id}`} placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <ActionButton
              disabledReason={firstReason(
                capabilityReason(caps, "repay"),
                centralBankReason(role),
                busy,
                amount && value === undefined && "Enter an amount above zero",
                value !== undefined && value > r.outstanding && "More than is outstanding",
              )}
              disabled={!amount}
              title="Repays on the bank's behalf, debiting its settlement balance and burning the cash (A13, A20)."
              onClick={() => void action.run(`Repay repo #${r.id}`, () => role.centralBank!.repay(r.id, value!))}
            >
              Repay
            </ActionButton>
          </>
        ) : null}
        {overdue ? (
          <ActionButton
            disabledReason={firstReason(capabilityReason(caps, "convertOverdue"), !role.actor && "Connect a signer first", busy)}
            onClick={() => void action.run(`Convert repo #${r.id}`, () => role.actor!.convertOverdue(r.id))}
          >
            Convert to penalty repo
          </ActionButton>
        ) : null}
        <ActionStatus state={action.state} />
      </td>
    </tr>
  );
}
