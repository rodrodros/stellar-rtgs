// The participant app: pick a network, act as a bank, and work its liquidity, payment orders,
// queues and credit. Everything below the network bar lives inside one core session, keyed on
// the network, so a switch drops the session, the store and the signer together.
import { defaultNetwork, loadNetworks, overridesStore, withOverrides, type Env, type NetworkId, type NetworkOverrides, type RtgsSession } from "@rtgs/core";
import { RtgsProvider, useConnection } from "@rtgs/core/react";
import { useMemo, useState } from "react";
import { BankBar } from "./connect/BankBar.tsx";
import { DeploymentSettings } from "./connect/DeploymentSettings.tsx";
import { NetworkSwitcher } from "./connect/NetworkSwitcher.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { ActingBankProvider } from "./session/ActingBank.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";

function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const sessionIds = new WeakMap<RtgsSession, number>();
let nextSessionId = 1;

/**
 * A key per session instance, not per network: right after a switch, `useConnection` still
 * returns the old session until its effect disposes it, and a subtree keyed on the network
 * would mount against that session just as it closes.
 */
function sessionKey(session: RtgsSession | undefined): string {
  if (!session) return "none";
  if (!sessionIds.has(session)) sessionIds.set(session, nextSessionId++);
  return `session:${sessionIds.get(session)}`;
}

export function App(props: { env?: Env; bank?: string }) {
  const env = props.env ?? (import.meta.env as Env);
  const networks = useMemo(() => loadNetworks(env), [env]);
  const overrides = useMemo(() => overridesStore(localStore(), "participant"), []);
  const [netId, setNetId] = useState<NetworkId>(() => defaultNetwork(networks, env).id);
  // Set only by the confirm dialog, and never persisted.
  const [mainnetAck, setMainnetAck] = useState(false);
  const [version, setVersion] = useState(0);

  const base = networks.find((n) => n.id === netId) ?? networks[0]!;
  const saved = useMemo<NetworkOverrides>(() => overrides.load(base.id), [overrides, base, version]);
  const network = useMemo(() => withOverrides(base, saved), [base, saved]);
  const options = useMemo(() => ({ env, ...(netId === "mainnet" && mainnetAck ? { acknowledgeMainnet: true as const } : {}) }), [env, netId, mainnetAck]);
  // `version` forces a reconnect on "Save and reconnect" even when the values didn't change.
  const connection = useConnection(netId === "mainnet" && !mainnetAck ? undefined : network, options, version);

  return (
    <div className="app">
      {netId === "mainnet" && (
        <div className="banner-mainnet" role="alert">
          Mainnet: every action moves real funds.
        </div>
      )}
      <header className="topbar">
        <h1>RTGS participant</h1>
        <NetworkSwitcher
          networks={networks}
          current={netId}
          onSelect={(id, ack) => {
            setMainnetAck(id === "mainnet" && ack);
            setNetId(id);
          }}
        />
      </header>
      {connection.connecting && <p className="status">Connecting to {network.label}…</p>}
      {connection.error && (
        <div className="tx tx-error" role="alert">
          <strong>{connection.error.title}</strong> {connection.error.detail}{" "}
          <button type="button" onClick={connection.reconnect}>
            Retry
          </button>
        </div>
      )}
      <ErrorBoundary key={sessionKey(connection.session)} onReset={connection.reconnect}>
        <RtgsProvider session={connection.session}>
          <ActingBankProvider {...(props.bank ? { initialBank: props.bank } : {})}>
            <BankBar />
            <Dashboard />
          </ActingBankProvider>
        </RtgsProvider>
      </ErrorBoundary>
      <DeploymentSettings
        key={`settings:${network.id}:${version}`}
        network={base}
        overrides={saved}
        onSave={(o) => {
          overrides.save(base.id, o);
          setVersion((v) => v + 1);
        }}
      />
    </div>
  );
}
