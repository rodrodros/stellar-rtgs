// The observer: pick a network and a settlement contract, then watch. It holds no keys and
// signs nothing on any network. The URL carries the whole view (state/query.tsx).
import { useEffect, useMemo, useState } from "react";
import { defaultNetwork, loadNetworks, RtgsProvider, useConnection, useSession, useSnapshot, type Env, type NetworkConfig, type RtgsError } from "./core.ts";
import { LedgerDrawer, PaymentDrawer, TxDrawer } from "./components/Drawers.tsx";
import { FlowMatrix } from "./components/FlowMatrix.tsx";
import { ChainStatus, ConnectBar, MainnetConfirm, PaymentSearch, RetentionBar } from "./components/Header.tsx";
import { BanksTable, CapabilityNote, CreditPanel, QueueGauge, QueueLanes } from "./components/System.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { toFeedStart } from "./model/retention.ts";
import { CLEAR_ON_NETWORK_CHANGE } from "./state/query.tsx";
import { QueryProvider, useQuery } from "./state/query.tsx";

function ErrorBanner(props: { error: RtgsError; network: NetworkConfig | undefined; onRetry?: () => void; onDismiss?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <strong>{props.error.title}.</strong> {props.error.detail}
      {props.network?.id === "devnet" && (
        <span className="muted">
          {" "}
          If the devnet was reset, bootstrap it again (central bank app), then reconnect: the new contract is found on the central bank's account.
        </span>
      )}
      {props.onRetry && (
        <button type="button" onClick={props.onRetry}>
          Reconnect
        </button>
      )}
      {props.onDismiss && (
        <button type="button" onClick={props.onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

function Dashboard(props: { onReconnect: () => void }) {
  const { query } = useQuery();
  const { network } = useSession();
  const status = useSnapshot((s) => s.status);
  const error = useSnapshot((s) => s.error);
  const registryError = useSnapshot((s) => s.registryError);
  // Core clears the store's error once a read succeeds again; until then it can be dismissed.
  const [dismissed, setDismissed] = useState<RtgsError>();
  return (
    <>
      <div className="status-row">
        <ChainStatus />
        <PaymentSearch />
      </div>
      <RetentionBar />
      <CapabilityNote />
      {error && error !== dismissed && (
        <ErrorBanner error={error} network={network} onRetry={props.onReconnect} onDismiss={() => setDismissed(error)} />
      )}
      {registryError && (
        <div className="banner banner-warn" role="status">
          Couldn't read the bank registry from the central bank's account ({registryError.detail}), so banks registered only there may be
          missing. It is read again every 30 seconds.
        </div>
      )}
      {status === "loading" && <p className="loading">Reading balances, queues and recent payment orders…</p>}
      <main className="grid">
        <div className="col col-system">
          <QueueGauge />
          <BanksTable />
          <CreditPanel />
        </div>
        <div className="col col-queues">
          <QueueLanes />
          <FlowMatrix />
        </div>
        <div className="col col-timeline">
          <Timeline />
        </div>
      </main>
      {query.payment !== undefined && <PaymentDrawer id={query.payment} />}
      {query.tx && <TxDrawer hash={query.tx} />}
      {query.ledger !== undefined && <LedgerDrawer ledger={query.ledger} />}
    </>
  );
}

function Observer(props: { env: Env }) {
  const { query, update } = useQuery();
  const { env } = props;
  const networks = useMemo(() => loadNetworks(env), [env]);
  const network = query.network ? networks.find((n) => n.id === query.network) : defaultNetwork(networks, env);
  // The default network goes into the URL too, so a shared link opens on the same network
  // whatever the recipient's build defaults to.
  useEffect(() => {
    if (!query.network && network) update({ network: network.id });
  }, [query.network, network, update]);
  // A link with a malformed contract id is refused, never answered with another contract.
  const blocked = query.invalidContract !== undefined;

  // Mainnet needs a confirmation every time it is chosen.
  const [mainnetConfirmed, setMainnetConfirmed] = useState(false);
  useEffect(() => {
    if (network?.id !== "mainnet") setMainnetConfirmed(false);
  }, [network?.id]);
  const awaitingConfirmation = network?.id === "mainnet" && !mainnetConfirmed;

  const options = useMemo(
    () => ({
      env,
      ...(query.contract ? { contractId: query.contract } : {}),
      ...(network?.id === "mainnet" && mainnetConfirmed ? { acknowledgeMainnet: true as const } : {}),
    }),
    [env, query.contract, network?.id, mainnetConfirmed],
  );
  // A new start ledger needs a new store, so it reconnects.
  const connection = useConnection(awaitingConfirmation || blocked ? undefined : network, options, String(query.from));
  const storeOptions = useMemo(() => ({ feed: { from: toFeedStart(query.from) } }), [query.from]);

  return (
    <div className="app">
      <header className="top">
        <h1>
          RTGS <span>observer</span>
        </h1>
        <ConnectBar networks={networks} selected={network?.id} contractId={query.contract ?? query.invalidContract ?? connection.session?.contractId} />
      </header>
      {query.network && !network && (
        <div className="banner banner-error" role="alert">
          {query.network === "mainnet"
            ? "Mainnet isn't enabled in this build: it needs VITE_RTGS_ENABLE_MAINNET=true (and VITE_RTGS_MAINNET_RPC_URL to connect)."
            : `There is no network "${query.network}" in this build.`}{" "}
          Choose a network above.
        </div>
      )}
      {blocked && (
        <div className="banner banner-error" role="alert">
          The link's settlement contract "{query.invalidContract}" isn't a contract id (C followed by 55 characters), so nothing is watched. Fix it
          above, or clear it to use the network's configured contract.
        </div>
      )}
      {awaitingConfirmation && (
        <MainnetConfirm
          onConfirm={() => setMainnetConfirmed(true)}
          onCancel={() =>
            update({ network: defaultNetwork(networks, env).id, ...CLEAR_ON_NETWORK_CHANGE, ...(typeof query.from === "number" ? { from: "retention" as const } : {}) })
          }
        />
      )}
      {connection.error && <ErrorBanner error={connection.error} network={network} onRetry={connection.reconnect} />}
      {connection.connecting && network && <p className="loading">Connecting to {network.label}…</p>}
      <RtgsProvider session={connection.session} storeOptions={storeOptions}>
        <Dashboard onReconnect={connection.reconnect} />
      </RtgsProvider>
    </div>
  );
}

/** `env`: the build's `VITE_RTGS_*` settings (packages/core/README.md). */
export function App(props: { env?: Env }) {
  return (
    <QueryProvider>
      <Observer env={props.env ?? (import.meta.env as Env)} />
    </QueryProvider>
  );
}
