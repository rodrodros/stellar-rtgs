// Who the app acts as. On the devnet: one of the demo identities, switched with one click and
// pinned per tab by `?bank=2`. On testnet and mainnet: a wallet. The provider sits under the
// session, which is keyed on the network, so a switch drops the signer with it.
import { connectWallet, devnetIdentities, disconnectWallet, toRtgsError, type RtgsActor, type RtgsError, type Signer } from "@rtgs/core";
import { useBankRegistry, useSession } from "@rtgs/core/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface ActingBank {
  signer?: Signer;
  actor?: RtgsActor;
  /** Devnet: the identities a demo can act as. Empty elsewhere. */
  identities: Signer[];
  choose: (signer: Signer | undefined) => void;
  connectWallet: () => Promise<void>;
  connecting: boolean;
  error?: RtgsError;
}

const Context = createContext<ActingBank | undefined>(undefined);

export function useActingBank(): ActingBank {
  const value = useContext(Context);
  if (!value) throw new Error("useActingBank outside <ActingBankProvider>");
  return value;
}

/** How many devnet identities to look for in the registry. */
const DEVNET_IDENTITIES = 20;
/** How many to offer when the registry knows none (before a bootstrap registered them). */
const DEVNET_FALLBACK = 3;

/** `"2"`, `"bank-2"`, `"Bank 2"` or the address. */
export function matchIdentity(wanted: string | null | undefined, identities: Signer[]): Signer | undefined {
  if (!wanted) return undefined;
  const n = /^(?:bank[- ]?)?(\d+)$/i.exec(wanted.trim())?.[1];
  if (n) return identities[Number(n) - 1];
  return identities.find((s) => s.address === wanted);
}

const storageKey = (network: string) => `rtgs:participant:bank:${network}`;

function readStored(network: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(network));
  } catch {
    return null;
  }
}

function remember(network: string, signer: Signer | undefined, index: number): void {
  try {
    if (signer) sessionStorage.setItem(storageKey(network), String(index + 1));
    else sessionStorage.removeItem(storageKey(network));
    const url = new URL(window.location.href);
    if (signer) url.searchParams.set("bank", String(index + 1));
    else url.searchParams.delete("bank");
    window.history.replaceState(null, "", url);
  } catch {
    // Not remembered; the choice still holds for this page.
  }
}

function urlBank(): string | null {
  try {
    return new URL(window.location.href).searchParams.get("bank");
  } catch {
    return null;
  }
}

export function ActingBankProvider(props: { initialBank?: string; children: ReactNode }) {
  const session = useSession();
  const net = session.network;
  const registry = useBankRegistry();

  const all = useMemo(() => (net.id === "devnet" ? devnetIdentities(net, DEVNET_IDENTITIES).banks : []), [net]);
  const identities = useMemo(() => {
    const known = new Set(registry.map((b) => b.address));
    const listed = all.filter((s) => known.has(s.address));
    return listed.length ? listed : all.slice(0, DEVNET_FALLBACK);
  }, [all, registry]);

  const [signer, setSigner] = useState<Signer | undefined>(() =>
    matchIdentity(props.initialBank ?? urlBank() ?? readStored(net.id), all),
  );
  const current = useRef(signer);
  current.current = signer;
  // The provider unmounts when the session goes (a network switch): forget a wallet with it.
  useEffect(
    () => () => {
      if (current.current?.kind === "wallet") void disconnectWallet().catch(() => {});
    },
    [],
  );
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<RtgsError>();

  const choose = useCallback(
    (next: Signer | undefined) => {
      setError(undefined);
      // Leaving a wallet: forget it in the kit too, so the next connect asks again.
      if (current.current?.kind === "wallet" && current.current !== next) void disconnectWallet().catch(() => {});
      setSigner(next);
      if (net.id === "devnet") remember(net.id, next, next ? all.findIndex((s) => s.address === next.address) : -1);
    },
    [all, net.id],
  );

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(undefined);
    try {
      setSigner(await connectWallet(net));
    } catch (e) {
      setError(toRtgsError(e));
    } finally {
      setConnecting(false);
    }
  }, [net]);

  const actor = useMemo(() => (signer ? session.as(signer) : undefined), [session, signer]);

  const value: ActingBank = {
    identities,
    choose,
    connectWallet: connect,
    connecting,
    ...(signer ? { signer } : {}),
    ...(actor ? { actor } : {}),
    ...(error ? { error } : {}),
  };
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
