// Keeper actions (ADR-0014, ADR-0015): anyone may reject an expired payment order or convert an
// overdue repo; nothing on the ledger runs by itself. "Due" follows the contract's guards on
// the latest ledger's close time.
import { useCapabilities, useSession, useSnapshot } from "@rtgs/core/react";
import { useMemo } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { ActionStatus } from "../components/ActionStatus.tsx";
import { Amount } from "../components/Amount.tsx";
import { capabilityReason, firstReason } from "../components/capability.ts";
import { useAction } from "../hooks/useAction.ts";
import { AUTO_KEEPER_INTERVAL_MS, useAutoKeeper } from "../keeper/AutoKeeperProvider.tsx";
import { expirablePayments, expiryOf, overdueRepos, termEndOf } from "../model/due.ts";
import { useRole } from "../session/role.ts";

export function Keeper() {
  const session = useSession();
  const caps = useCapabilities();
  const role = useRole();
  const payments = useSnapshot((s) => s.payments);
  const repos = useSnapshot((s) => s.repos);
  const config = useSnapshot((s) => s.config);
  const closeTime = useSnapshot((s) => s.ledger?.closeTime);
  const action = useAction();
  const auto = useAutoKeeper();

  const duePayments = useMemo(
    () => (config && closeTime !== undefined ? expirablePayments(payments.values(), config, closeTime) : []),
    [payments, config, closeTime],
  );
  const dueRepos = useMemo(() => (config && closeTime !== undefined ? overdueRepos(repos.values(), config, closeTime) : []), [repos, config, closeTime]);

  const actor = role.actor;
  const noSigner = !actor && "Connect a signer first";
  const busy = action.busy && "Busy";
  const expireReason = firstReason(capabilityReason(caps, "expire"), noSigner, busy);
  const convertReason = firstReason(capabilityReason(caps, "convertOverdue"), noSigner, busy);

  const code = session.cashToken.code;
  return (
    <section>
      <h2>Keeper</h2>
      {caps.expire === "stub" || caps.convertOverdue === "stub" ? (
        <p className="status warn" role="status">
          Not implemented by this contract yet: {[caps.expire === "stub" && "expire", caps.convertOverdue === "stub" && "convert_overdue"].filter(Boolean).join(", ")}.
        </p>
      ) : null}
      <div className="card">
        <label className="inline">
          <input type="checkbox" checked={auto.enabled} disabled={!!auto.disabledReason} onChange={(e) => auto.setEnabled(e.target.checked)} />
          Auto-keeper: every {AUTO_KEEPER_INTERVAL_MS / 1000}s, reject expired payment orders and convert overdue repos
        </label>
        {auto.disabledReason ? <span className="hint">{auto.disabledReason}</span> : null}
        <p className="small muted">
          It runs while this browser tab is open, on any page, signing with the connected signer. Switching network, contract or
          signer turns it off. An always-on keeper needs a server, which this project doesn't have.
        </p>
        {auto.log.length ? (
          <ul className="small">
            {auto.log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <h3>Payment orders past expiry</h3>
      {duePayments.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <>
          <ul>
            {duePayments.map((p) => (
              <li key={String(p.id)}>
                <span className="mono">#{String(p.id)}</span> {session.registry.nameOf(p.from)} → {session.registry.nameOf(p.to)}{" "}
                <Amount value={p.amount} code={code} /> · {p.priority} · past expiry since{" "}
                {new Date(expiryOf(p, config!) * 1000).toISOString().replace(".000Z", "Z")}{" "}
                <ActionButton disabledReason={expireReason} onClick={() => void action.run(`Expire #${p.id}`, () => actor!.expire(p.id))}>
                  Expire
                </ActionButton>
              </li>
            ))}
          </ul>
          <ActionButton
            disabledReason={expireReason}
            onClick={() =>
              void action.run(`Expire ${duePayments.length} payment orders`, async () => {
                for (const p of duePayments) await actor!.expire(p.id);
              })
            }
          >
            Expire all
          </ActionButton>
        </>
      )}

      <h3>Repos past their term</h3>
      {dueRepos.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <>
          <ul>
            {dueRepos.map((r) => (
              <li key={String(r.id)}>
                <span className="mono">#{String(r.id)}</span> {session.registry.nameOf(r.bank)} <Amount value={r.outstanding} code={code} />{" "}
                outstanding · term ended {new Date(termEndOf(r, config!) * 1000).toISOString().replace(".000Z", "Z")}{" "}
                <ActionButton disabledReason={convertReason} onClick={() => void action.run(`Convert repo #${r.id}`, () => actor!.convertOverdue(r.id))}>
                  Convert
                </ActionButton>
              </li>
            ))}
          </ul>
          <ActionButton
            disabledReason={convertReason}
            onClick={() =>
              void action.run(`Convert ${dueRepos.length} repos`, async () => {
                for (const r of dueRepos) await actor!.convertOverdue(r.id);
              })
            }
          >
            Convert all
          </ActionButton>
        </>
      )}
      <ActionStatus state={action.state} />
    </section>
  );
}
