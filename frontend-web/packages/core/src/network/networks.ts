// The network registry: devnet, testnet and (opt-in) mainnet. Values come from the defaults
// below, then from env (`VITE_RTGS_*`, or `RTGS_*` in Node), then from runtime overrides.
import { RtgsError } from "../errors.ts";

export type NetworkId = "devnet" | "testnet" | "mainnet";

export const PASSPHRASES: Readonly<Record<NetworkId, string>> = {
  devnet: "Standalone Network ; February 2017",
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

/** A participant known off-chain (spec fact 2). */
export interface BankEntry {
  address: string;
  name?: string;
}

export interface NetworkConfig {
  id: NetworkId;
  label: string;
  rpcUrl: string;
  passphrase: string;
  friendbotUrl?: string;
  /** The settlement contract. On devnet it is discovered from the central bank when unset. */
  contractId?: string;
  /** The central bank's account, for discovery and the bank registry. Derived on devnet. */
  centralBank?: string;
  /** Banks listed in config; merged with the ledger registry and the event feed. */
  banks: BankEntry[];
  /** The seed the demo identities derive from: always on the devnet, opt-in on the testnet. */
  devnetSeed?: string;
  allowHttp: boolean;
  /** Block explorer URL templates, with `{hash}` and `{ledger}`; none for the devnet. */
  explorer?: { txUrl: string; ledgerUrl: string };
}

const STELLAR_EXPERT = (path: "testnet" | "public") => ({
  txUrl: `https://stellar.expert/explorer/${path}/tx/{hash}`,
  ledgerUrl: `https://stellar.expert/explorer/${path}/ledger/{ledger}`,
});

/** A link to a transaction on the network's explorer, if it has one. */
export function txUrl(net: Pick<NetworkConfig, "explorer">, hash: string): string | undefined {
  return net.explorer?.txUrl.replace("{hash}", encodeURIComponent(hash));
}

/** A link to a ledger on the network's explorer, if it has one. */
export function ledgerUrl(net: Pick<NetworkConfig, "explorer">, ledger: number): string | undefined {
  return net.explorer?.ledgerUrl.replace("{ledger}", String(ledger));
}

function explorerFrom(env: Env, net: string, fallback?: { txUrl: string; ledgerUrl: string }) {
  const txUrl = readEnv(env, `${net}_EXPLORER_TX_URL`) ?? fallback?.txUrl;
  const ledgerUrl = readEnv(env, `${net}_EXPLORER_LEDGER_URL`) ?? fallback?.ledgerUrl;
  return txUrl && ledgerUrl ? { explorer: { txUrl, ledgerUrl } } : {};
}

/** The public demo seed. Devnet only: the signers refuse any other network. */
export const DEFAULT_DEVNET_SEED = "rtgs-devnet-demo";
const DEFAULT_DEVNET_RPC = "http://localhost:8300/rpc";
const DEFAULT_TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_FRIENDBOT = "https://friendbot.stellar.org";

export type Env = Record<string, string | boolean | undefined>;

/** `VITE_RTGS_<name>` (Vite), else `RTGS_<name>` (Node); empty counts as unset. */
export function readEnv(env: Env, name: string): string | undefined {
  const value = env[`VITE_RTGS_${name}`] ?? env[`RTGS_${name}`];
  if (value === undefined || value === "") return undefined;
  return String(value);
}

/**
 * RPC advertises friendbot at the container's port 8000, which is wrong on a remapped port
 * (C-HB-073), so the devnet friendbot is always derived from the RPC URL.
 */
export function devnetFriendbotUrl(rpcUrl: string): string {
  return new URL("/friendbot", rpcUrl).toString();
}

function isLocal(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * `"G...:Bank A,G...:Bank B"` or a JSON array of `{ address, name }`. Throws on malformed
 * input rather than silently dropping banks.
 */
export function parseBanks(text: string | undefined): BankEntry[] {
  if (!text) return [];
  if (text.trim().startsWith("[")) {
    const parsed = JSON.parse(text) as BankEntry[];
    if (!Array.isArray(parsed) || parsed.some((b) => typeof b?.address !== "string")) {
      throw new RtgsError("config", "Invalid bank list", "Expected a JSON array of { address, name }.");
    }
    return parsed.map((b) => (b.name ? { address: b.address, name: b.name } : { address: b.address }));
  }
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const [address = "", ...name] = item.split(":");
      return name.length ? { address: address.trim(), name: name.join(":").trim() } : { address: address.trim() };
    });
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** Whether the network has demo identities derived from a seed: the devnet, or a seeded testnet. */
export function hasSeed(net: Pick<NetworkConfig, "id" | "devnetSeed">): boolean {
  return net.id === "devnet" || (net.id === "testnet" && net.devnetSeed !== undefined);
}

export function mainnetEnabled(env: Env): boolean {
  return readEnv(env, "ENABLE_MAINNET") === "true";
}

/**
 * The networks this build offers. Mainnet is listed only when `VITE_RTGS_ENABLE_MAINNET=true`;
 * it has no default RPC, so `VITE_RTGS_MAINNET_RPC_URL` must be set too.
 */
export function loadNetworks(env: Env = {}): NetworkConfig[] {
  const devnetRpc = readEnv(env, "DEVNET_RPC_URL") ?? DEFAULT_DEVNET_RPC;
  const networks: NetworkConfig[] = [
    {
      id: "devnet",
      label: "Devnet (local)",
      rpcUrl: devnetRpc,
      passphrase: PASSPHRASES.devnet,
      friendbotUrl: readEnv(env, "DEVNET_FRIENDBOT_URL") ?? devnetFriendbotUrl(devnetRpc),
      ...optional("contractId", readEnv(env, "DEVNET_CONTRACT_ID")),
      ...optional("centralBank", readEnv(env, "DEVNET_CENTRAL_BANK")),
      banks: parseBanks(readEnv(env, "DEVNET_BANKS")),
      devnetSeed: readEnv(env, "DEVNET_SEED") ?? DEFAULT_DEVNET_SEED,
      allowHttp: true,
      ...explorerFrom(env, "DEVNET"),
    },
  ];
  const testnetRpc = readEnv(env, "TESTNET_RPC_URL") ?? DEFAULT_TESTNET_RPC;
  networks.push({
    id: "testnet",
    label: "Testnet",
    rpcUrl: testnetRpc,
    passphrase: PASSPHRASES.testnet,
    friendbotUrl: readEnv(env, "TESTNET_FRIENDBOT_URL") ?? TESTNET_FRIENDBOT,
    ...optional("contractId", readEnv(env, "TESTNET_CONTRACT_ID")),
    ...optional("centralBank", readEnv(env, "TESTNET_CENTRAL_BANK")),
    banks: parseBanks(readEnv(env, "TESTNET_BANKS")),
    ...optional("devnetSeed", readEnv(env, "TESTNET_SEED")),
    allowHttp: isLocal(testnetRpc),
    ...explorerFrom(env, "TESTNET", STELLAR_EXPERT("testnet")),
  });
  if (mainnetEnabled(env)) {
    const mainnetRpc = readEnv(env, "MAINNET_RPC_URL") ?? "";
    networks.push({
      id: "mainnet",
      label: "Mainnet",
      rpcUrl: mainnetRpc,
      passphrase: PASSPHRASES.mainnet,
      ...optional("contractId", readEnv(env, "MAINNET_CONTRACT_ID")),
      ...optional("centralBank", readEnv(env, "MAINNET_CENTRAL_BANK")),
      banks: parseBanks(readEnv(env, "MAINNET_BANKS")),
      allowHttp: false,
      ...explorerFrom(env, "MAINNET", STELLAR_EXPERT("public")),
    });
  }
  return networks;
}

/** The network to select first: `VITE_RTGS_DEFAULT_NETWORK` if offered and not mainnet, else devnet. */
export function defaultNetwork(networks: NetworkConfig[], env: Env = {}): NetworkConfig {
  const wanted = readEnv(env, "DEFAULT_NETWORK");
  const found = networks.find((n) => n.id === wanted && n.id !== "mainnet");
  return found ?? networks.find((n) => n.id === "devnet") ?? networks[0]!;
}

/** What a user may change at runtime, per network. */
export type NetworkOverrides = Partial<Pick<NetworkConfig, "rpcUrl" | "friendbotUrl" | "contractId" | "centralBank">>;

export function withOverrides(net: NetworkConfig, overrides: NetworkOverrides = {}): NetworkConfig {
  const next: NetworkConfig = { ...net, banks: [...net.banks] };
  for (const [key, value] of Object.entries(overrides) as [keyof NetworkOverrides, string | undefined][]) {
    if (value === undefined) continue;
    if (value === "") delete next[key];
    else next[key] = value;
  }
  if (overrides.rpcUrl) {
    if (net.id === "devnet" && !overrides.friendbotUrl) next.friendbotUrl = devnetFriendbotUrl(overrides.rpcUrl);
    next.allowHttp = net.id === "devnet" || isLocal(overrides.rpcUrl);
  }
  return next;
}

/**
 * Per-app persistence of runtime overrides, keyed by network. Storage may be missing or throw
 * (private windows), in which case overrides just don't persist.
 */
export function overridesStore(storage: Pick<Storage, "getItem" | "setItem"> | undefined, appKey: string) {
  const key = (id: NetworkId) => `rtgs:${appKey}:network:${id}`;
  return {
    load(id: NetworkId): NetworkOverrides {
      try {
        return JSON.parse(storage?.getItem(key(id)) ?? "{}") as NetworkOverrides;
      } catch {
        return {};
      }
    },
    save(id: NetworkId, overrides: NetworkOverrides): void {
      try {
        storage?.setItem(key(id), JSON.stringify(overrides));
      } catch {
        // Not persisted; the override still applies to this session.
      }
    },
  };
}
