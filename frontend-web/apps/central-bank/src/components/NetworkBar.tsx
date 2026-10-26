// The top bar: the network switch (mainnet only behind a typed confirmation), the contract,
// the signer and its role, and the ledger clock.
import { connectWallet, devnetIdentities, disconnectWallet, hasSeed, toRtgsError, type NetworkId, type RtgsError } from "@rtgs/core";
import { useState } from "react";
import { useAppSession } from "../session/AppSession.tsx";
import { Address } from "./Address.tsx";
import { TypedConfirmDialog } from "./TypedConfirmDialog.tsx";

export function NetworkBar() {
  const app = useAppSession();
  const [askMainnet, setAskMainnet] = useState(false);

  const onSelect = (id: NetworkId) => {
    if (id === "mainnet") setAskMainnet(true);
    else app.selectNetwork(id);
  };

  return (
    <header className="topbar">
      <strong className="brand">RTGS · Central bank</strong>
      <label>
        Network{" "}
        <select aria-label="Network" value={app.network.id} onChange={(e) => onSelect(e.target.value as NetworkId)}>
          {app.networks.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>
      {app.network.id === "mainnet" ? <span className="badge danger">MAINNET: real funds</span> : null}
      {app.session ? (
        <span>
          Contract <Address address={app.session.contractId} />
        </span>
      ) : null}
      <SignerPanel />
      {askMainnet ? (
        <TypedConfirmDialog
          title="Switch to mainnet?"
          word="mainnet"
          confirmLabel="Use mainnet"
          onCancel={() => setAskMainnet(false)}
          onConfirm={() => {
            setAskMainnet(false);
            app.selectNetwork("mainnet", { acknowledgeMainnet: true });
          }}
        >
          <p>
            Mainnet moves real funds. Every action you sign as the central bank is final. The app goes back to the
            default network the next time it loads.
          </p>
        </TypedConfirmDialog>
      ) : null}
    </header>
  );
}

function SignerPanel() {
  const app = useAppSession();
  const [error, setError] = useState<RtgsError>();
  const [connecting, setConnecting] = useState(false);
  const { signer, session, network } = app;
  const role = !signer || !session ? undefined : signer.address === session.centralBank ? "central bank" : "not the central bank";

  const connect = async () => {
    setConnecting(true);
    setError(undefined);
    try {
      app.setSigner(await connectWallet(network));
    } catch (e) {
      setError(toRtgsError(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <span className="signer">
      {signer ? (
        <>
          Signer <Address address={signer.address} name={signer.label} />{" "}
          {role ? <span className={role === "central bank" ? "badge ok" : "badge warn"}>{role}</span> : null}
          <button
            type="button"
            onClick={() => {
              if (signer.kind === "wallet") void disconnectWallet().catch(() => {});
              app.setSigner(undefined);
            }}
          >
            Disconnect
          </button>
        </>
      ) : hasSeed(network) ? (
        <button type="button" onClick={() => app.setSigner(devnetIdentities(network, 0).centralBank)}>
          Use the demo central bank key
        </button>
      ) : (
        <button type="button" onClick={connect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      )}
      {error ? (
        <span className="hint error" role="alert">
          {error.title}: {error.detail}
        </span>
      ) : null}
    </span>
  );
}
