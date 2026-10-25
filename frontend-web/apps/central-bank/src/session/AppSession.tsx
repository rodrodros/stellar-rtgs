// The app's connection state: which network, its runtime overrides, the mainnet confirmation,
// the signer, and the core session they produce. Switching networks drops the signer and
// disposes the old session (core's useConnection), so nothing outlives the switch.
import {
  defaultNetwork,
  devnetIdentities,
  loadNetworks,
  overridesStore,
  withOverrides,
  type Env,
  type NetworkConfig,
  type NetworkId,
  type NetworkOverrides,
  type RtgsError,
  type RtgsSession,
  type Signer,
} from "@rtgs/core";
import { useConnection } from "@rtgs/core/react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface AppSession {
  networks: NetworkConfig[];
  /** The selected network, with this app's runtime overrides applied. */
  network: NetworkConfig;
  /** Selects a network. Mainnet needs `acknowledgeMainnet`, from the confirmation dialog. */
  selectNetwork(id: NetworkId, opts?: { acknowledgeMainnet?: true }): void;
  overrides: NetworkOverrides;
  saveOverrides(overrides: NetworkOverrides): void;
  /** The signer, only if it belongs to the selected network. */
  signer: Signer | undefined;
  setSigner(signer: Signer | undefined): void;
  session: RtgsSession | undefined;
  connecting: boolean;
  error: RtgsError | undefined;
  /** Connects again, e.g. after a devnet bootstrap published a new contract. */
  reconnect(): void;
}

/** Exported for tests, which provide a fixed session without connecting. */
export const AppSessionContext = createContext<AppSession | undefined>(undefined);

/** A signer counts only on the network whose passphrase it was made for. */
export function signerFor(signer: Signer | undefined, network: Pick<NetworkConfig, "passphrase">): Signer | undefined {
  return signer && signer.networkPassphrase === network.passphrase ? signer : undefined;
}

/** On devnet the central bank's key is derived in the browser, so it is the default signer. */
export function defaultSigner(network: NetworkConfig): Signer | undefined {
  return network.id === "devnet" ? devnetIdentities(network, 0).centralBank : undefined;
}

const APP_KEY = "central-bank";

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function AppSessionProvider(props: { env: Env; children: ReactNode }) {
  const networks = useMemo(() => loadNetworks(props.env), [props.env]);
  const store = useMemo(() => overridesStore(browserStorage(), APP_KEY), []);
  // The app always starts on the default network, which is never mainnet.
  const [selected, setSelected] = useState<{ id: NetworkId; mainnetAck: boolean }>(() => ({
    id: defaultNetwork(networks, props.env).id,
    mainnetAck: false,
  }));
  const [overrides, setOverrides] = useState<NetworkOverrides>(() => store.load(selected.id));
  const base = networks.find((n) => n.id === selected.id) ?? networks[0]!;
  const network = useMemo(() => withOverrides(base, overrides), [base, overrides]);
  const [signerState, setSignerState] = useState<Signer | undefined>(() => defaultSigner(network));
  const [epoch, setEpoch] = useState(0);

  const selectNetwork = useCallback(
    (id: NetworkId, opts: { acknowledgeMainnet?: true } = {}) => {
      if (id === "mainnet" && opts.acknowledgeMainnet !== true) return;
      const next = networks.find((n) => n.id === id);
      if (!next) return;
      const nextOverrides = store.load(id);
      setSelected({ id, mainnetAck: id === "mainnet" });
      setOverrides(nextOverrides);
      setSignerState(defaultSigner(withOverrides(next, nextOverrides)));
    },
    [networks, store],
  );

  const saveOverrides = useCallback(
    (next: NetworkOverrides) => {
      store.save(selected.id, next);
      setOverrides(next);
    },
    [store, selected.id],
  );

  const options = useMemo(
    () => (selected.id === "mainnet" && selected.mainnetAck ? { acknowledgeMainnet: true as const, env: props.env } : { env: props.env }),
    [selected, props.env],
  );
  const connection = useConnection(network, options, epoch);
  const reconnect = useCallback(() => setEpoch((n) => n + 1), []);

  const value: AppSession = {
    networks,
    network,
    selectNetwork,
    overrides,
    saveOverrides,
    signer: signerFor(signerState, network),
    setSigner: setSignerState,
    session: connection.session,
    connecting: connection.connecting,
    error: connection.error,
    reconnect,
  };
  return <AppSessionContext.Provider value={value}>{props.children}</AppSessionContext.Provider>;
}

export function useAppSession(): AppSession {
  const value = useContext(AppSessionContext);
  if (!value) throw new Error("useAppSession outside <AppSessionProvider>");
  return value;
}
