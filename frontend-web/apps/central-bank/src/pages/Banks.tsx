// Bank onboarding and cash token administration (ADR-0003, ADR-0006). The bank registry is
// core's (spec fact 2): config, the central bank's account, the devnet identities and every
// address the events mention. Registering a bank writes it to the central bank's account.
import { CLAWBACK_LIMITS, parseAmount, type Bank, type Holding } from "@rtgs/core";
import { useBankRegistry, useSession, useSnapshot } from "@rtgs/core/react";
import { useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { ActionStatus } from "../components/ActionStatus.tsx";
import { Address } from "../components/Address.tsx";
import { Amount } from "../components/Amount.tsx";
import { TypedConfirmDialog } from "../components/TypedConfirmDialog.tsx";
import { firstReason } from "../components/capability.ts";
import { useAction } from "../hooks/useAction.ts";
import { useLedgerReads } from "../hooks/useLedgerReads.ts";
import { isBank } from "../model/accounts.ts";
import { centralBankReason, tokenAdminReason, useRole, type Role } from "../session/role.ts";

export function Banks() {
  const session = useSession();
  const role = useRole();
  const banks = useBankRegistry();
  const reads = useLedgerReads(banks.map((b) => b.address));
  const code = session.cashToken.code;

  return (
    <section>
      <h2>Banks and the cash token</h2>
      <p className="muted">
        The cash token is {code}, a classic asset issued by <Address address={session.cashToken.issuer} /> and used through its
        SAC (ADR-0003). Its holdings here are cash outside the RTGS; settlement balances live in the settlement contract.
      </p>
      {reads.error ? (
        <p className="status error" role="alert">
          {reads.error.title}: {reads.error.detail}
        </p>
      ) : null}
      <ContractRow role={role} holding={reads.contract} onChange={reads.reload} />
      <table className="table">
        <thead>
          <tr>
            <th>Bank</th>
            <th>Trustline</th>
            <th>Cash token holding</th>
            <th>Settlement balance</th>
            <th>Collateral</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {banks
            .filter((bank) => isBank(bank.address, session))
            .map((bank) => (
            <BankRow key={bank.address} bank={bank} holding={reads.holdings.get(bank.address)} role={role} code={code} onChange={reads.reload} />
          ))}
          {banks.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No banks yet. Register one below{session.network.id === "devnet" ? ", or run the bootstrap on the Setup page" : ""}.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <RegisterBank role={role} />
    </section>
  );
}

/** The settlement contract as a holder: authorizing it is setup, deauthorizing it freezes the RTGS (H1). */
function ContractRow(props: { role: Role; holding: Holding | undefined; onChange(): void }) {
  const session = useSession();
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  const admin = props.role.tokenAdmin;
  const reason = firstReason(tokenAdminReason(props.role), action.busy && "Busy");
  const authorized = props.holding?.authorized;

  return (
    <div className="card">
      <h3>Settlement contract</h3>
      <p>
        <Address address={session.contractId} /> holds <Amount value={props.holding?.balance} code={session.cashToken.code} /> in
        custody.{" "}
        {authorized === undefined ? null : authorized ? (
          <span className="badge ok">authorized</span>
        ) : (
          <span className="badge danger">not authorized: deposits and withdrawals fail</span>
        )}
      </p>
      {authorized === false ? (
        <ActionButton
          disabledReason={reason}
          onClick={() => void action.run("Authorize the settlement contract", () => admin!.authorize(session.contractId, true)).then(props.onChange)}
        >
          Authorize the contract
        </ActionButton>
      ) : (
        <ActionButton className="danger" disabledReason={reason} onClick={() => setConfirm(true)}>
          Deauthorize (freeze) the contract
        </ActionButton>
      )}
      <ActionStatus state={action.state} />
      {confirm ? (
        <TypedConfirmDialog
          title="Freeze the settlement contract?"
          word="FREEZE"
          confirmLabel="Deauthorize the contract"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void action.run("Deauthorize the settlement contract", () => admin!.authorize(session.contractId, false)).then(props.onChange);
          }}
        >
          <p>
            The contract holds every bank's settlement balance. Deauthorizing it as a cash token holder makes every deposit and
            withdrawal fail, for every bank, until you authorize it again: the whole RTGS stops moving money in or out
            (hazard H1). Payments between settlement balances still settle.
          </p>
        </TypedConfirmDialog>
      ) : null}
    </div>
  );
}

function BankRow(props: { bank: Bank; holding: Holding | undefined; role: Role; code: string; onChange(): void }) {
  const { bank, holding, role, code } = props;
  const session = useSession();
  const view = useSnapshot((s) => s.banks.get(bank.address));
  const collateral = useSnapshot((s) => s.collateral.get(bank.address));
  const action = useAction();
  const [amount, setAmount] = useState("");
  const [clawback, setClawback] = useState(false);
  const admin = role.tokenAdmin;
  const adminReason = firstReason(tokenAdminReason(role), action.busy && "Busy");
  const amountReason = amountProblem(amount);

  const done = () => props.onChange();

  return (
    <tr>
      <td>
        <Address address={bank.address} name={bank.name} />
        <div className="muted small">{bank.sources.join(", ")}</div>
      </td>
      <td>
        {!holding ? (
          <span className="muted">…</span>
        ) : !holding.exists ? (
          <span className="badge warn">no trustline</span>
        ) : holding.authorized ? (
          <span className="badge ok">authorized</span>
        ) : (
          <span className="badge warn">not authorized</span>
        )}
      </td>
      <td>
        <Amount value={holding?.balance} code={code} />
      </td>
      <td>
        <Amount value={view?.balance} code={code} />
      </td>
      <td>
        <Amount value={view?.credit?.collateral ?? collateral} code={code} />
      </td>
      <td className="actions">
        {holding?.exists ? (
          holding.authorized ? (
            <ActionButton
              disabledReason={adminReason}
              title="Stops the bank's deposits and withdrawals; its payments inside the contract still settle."
              onClick={() => void action.run(`Deauthorize ${bank.name ?? "the bank"}`, () => admin!.authorize(bank.address, false)).then(done)}
            >
              Deauthorize
            </ActionButton>
          ) : (
            <ActionButton
              disabledReason={adminReason}
              onClick={() => void action.run(`Authorize ${bank.name ?? "the bank"}`, () => admin!.authorize(bank.address, true)).then(done)}
            >
              Authorize
            </ActionButton>
          )
        ) : (
          <span className="hint">The bank opens its trustline from its own app first.</span>
        )}
        <input aria-label={`Amount for ${bank.name ?? bank.address}`} placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <ActionButton
          disabledReason={firstReason(adminReason, !holding?.authorized && "The trustline must be authorized", amount && amountReason)}
          disabled={!amount}
          onClick={() => void action.run(`Issue cash to ${bank.name ?? "the bank"}`, () => admin!.issue(bank.address, parseAmount(amount))).then(done)}
        >
          Issue
        </ActionButton>
        <ActionButton disabledReason={firstReason(adminReason, !holding?.balance && "Nothing to claw back")} onClick={() => setClawback(true)}>
          Clawback…
        </ActionButton>
        <ActionStatus state={action.state} />
        {clawback ? (
          <ClawbackDialog
            bank={bank}
            holding={holding?.balance ?? 0n}
            code={code}
            onCancel={() => setClawback(false)}
            onConfirm={(value) => {
              setClawback(false);
              void action
                .run(`Claw back from ${bank.name ?? "the bank"}`, () => admin!.clawback(bank.address, value, session.contractId))
                .then(done);
            }}
          />
        ) : null}
      </td>
    </tr>
  );
}

function amountProblem(text: string): string | undefined {
  try {
    return parseAmount(text) > 0n ? undefined : "Enter an amount above zero";
  } catch {
    return "Enter an amount, e.g. 100 or 12.5";
  }
}

/**
 * Clawback only reaches cash a bank holds outside the RTGS, on its trustline. It is never
 * offered against the settlement contract (H1), and core refuses that too.
 */
function ClawbackDialog(props: { bank: Bank; holding: bigint; code: string; onConfirm(value: bigint): void; onCancel(): void }) {
  const [amount, setAmount] = useState("");
  const problem = amountProblem(amount);
  const value = problem ? undefined : parseAmount(amount);
  const tooMuch = value !== undefined && value > props.holding;
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Clawback">
        <h3>Claw back from {props.bank.name ?? props.bank.address}</h3>
        <div className="dialog-body">
          <p>{CLAWBACK_LIMITS}</p>
          <p>
            Here it can remove up to <Amount value={props.holding} code={props.code} /> the bank holds on its trustline, outside the
            RTGS. It can't touch the bank's settlement balance in the settlement contract, or reverse a settled payment, which is
            final (ADR-0005).
          </p>
        </div>
        <label>
          Amount
          <input aria-label="Clawback amount" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </label>
        {amount && (problem || tooMuch) ? <p className="hint">{problem ?? "More than the bank holds"}</p> : null}
        <div className="row">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" disabled={value === undefined || tooMuch} onClick={() => props.onConfirm(value!)}>
            Claw back
          </button>
        </div>
      </div>
    </div>
  );
}

function RegisterBank(props: { role: Role }) {
  const session = useSession();
  const banks = useBankRegistry();
  const action = useAction();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const reason = firstReason(centralBankReason(props.role), action.busy && "Busy");
  const registered = banks.filter((b) => b.sources.includes("ledger"));

  return (
    <div className="card">
      <h3>Bank registry</h3>
      <p className="muted">
        The contract keeps no list of banks. Registering writes the bank's address and name to the central bank's account, where
        every app reads it. On testnet and mainnet a bank opens its own trustline from the participant app; then authorize it and
        issue cash above.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const entry = name.trim() ? { address: address.trim(), name: name.trim() } : { address: address.trim() };
          void action.run(`Register ${entry.name ?? "the bank"}`, () => session.registry.register(props.role.signer!, entry)).then((result) => {
            // Keep what was typed when registration failed, so it can be corrected.
            if (result === undefined) return;
            setAddress("");
            setName("");
          });
        }}
      >
        <input aria-label="Bank address" placeholder="G… address" value={address} onChange={(e) => setAddress(e.target.value)} />
        <input aria-label="Bank name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <ActionButton type="submit" disabledReason={reason} disabled={!address.trim()}>
          Register or rename
        </ActionButton>
      </form>
      {registered.length ? (
        <ul>
          {registered.map((b) => (
            <li key={b.address}>
              <Address address={b.address} name={b.name} />{" "}
              <ActionButton
                disabledReason={reason}
                onClick={() => void action.run(`Unregister ${b.name ?? "the bank"}`, () => session.registry.unregister(props.role.signer!, b.address))}
              >
                Unregister
              </ActionButton>
            </li>
          ))}
        </ul>
      ) : null}
      <ActionStatus state={action.state} />
    </div>
  );
}
