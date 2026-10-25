// Who the app acts as, and the state of the connection: the RTGS clock and the event feed.
import { useFeedStatus, useLedgerClock, useSession } from "@rtgs/core/react";
import { useActingBank } from "../session/ActingBank.tsx";
import { ledgerTime, shortAddress } from "../ui/format.ts";

export function BankBar() {
  const session = useSession();
  const bank = useActingBank();
  const devnet = session.network.id === "devnet";
  return (
    <div className="bankbar">
      <div className="who">
        {devnet ? (
          <div role="group" aria-label="Act as" className="row">
            <span>Act as</span>
            {bank.identities.map((s) => (
              <button
                key={s.address}
                type="button"
                aria-pressed={bank.signer?.address === s.address}
                onClick={() => bank.choose(s)}
              >
                {session.registry.get(s.address)?.name ?? s.label}
              </button>
            ))}
          </div>
        ) : bank.signer ? (
          <div className="row">
            <span>
              Wallet <code>{shortAddress(bank.signer.address)}</code>
            </span>
            <button type="button" onClick={() => bank.choose(undefined)}>
              Disconnect
            </button>
          </div>
        ) : (
          <button type="button" className="primary" disabled={bank.connecting} onClick={() => void bank.connectWallet()}>
            {bank.connecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
        {bank.error && (
          <p className="tx tx-error" role="alert">
            <strong>{bank.error.title}</strong> {bank.error.detail}
          </p>
        )}
        {bank.signer && !devnet && !session.registry.get(bank.signer.address) && (
          <p className="note warn">This account isn't in the bank registry of this deployment.</p>
        )}
      </div>
      <Clock />
    </div>
  );
}

function Clock() {
  const session = useSession();
  const feed = useFeedStatus();
  const { sequence, closeTime } = useLedgerClock();
  return (
    <div className="clock meta">
      <span className={`dot dot-${feed.state}`} aria-hidden="true" /> Feed {feed.state}
      {sequence !== undefined && closeTime !== undefined && (
        <>
          {" · "}ledger {sequence} closed {ledgerTime(closeTime)}
        </>
      )}
      {" · "}contract <code title={session.contractId}>{shortAddress(session.contractId)}</code>
    </div>
  );
}
