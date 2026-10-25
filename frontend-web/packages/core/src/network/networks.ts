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
  /** The seed devnet identities derive from (devnet only). */
  devnetSeed?: string;
  allowHttp: boolean;
}

/** The public demo seed. Devnet only: the signers refuse any other network. */
export const DEFAULT_DEVNET_SEED = "rtgs-devnet-demo";
const DEFAULT_DEVNET_RPC = "http://localhost:8300/rpc";
const DEFAULT_TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_FRIENDBOT = "https://friendbot.stellar.org";

export type Env = Record<string, string | boolean | undefined>;

function read(env: Env, name: string): string | undefined {
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

export function mainnetEnabled(env: Env): boolean {
  return read(env, "ENABLE_MAINNET") === "true";
}

/**
 * The networks this build offers. Mainnet is listed only when `VITE_RTGS_ENABLE_MAINNET=true`;
 * it has no default RPC, so `VITE_RTGS_MAINNET_RPC_URL` must be set too.
 */
export function loadNetworks(env: Env = {}): NetworkConfig[] {
  const devnetRpc = read(env, "DEVNET_RPC_URL") ?? DEFAULT_DEVNET_RPC;
  const networks: NetworkConfig[] = [
    {
      id: "devnet",
      label: "Devnet (local)",
      rpcUrl: devnetRpc,
      passphrase: PASSPHRASES.devnet,
      friendbotUrl: read(env, "DEVNET_FRIENDBOT_URL") ?? devnetFriendbotUrl(devnetRpc),
      ...optional("contractId", read(env, "DEVNET_CONTRACT_ID")),
      ...optional("centralBank", read(env, "DEVNET_CENTRAL_BANK")),
      banks: parseBanks(read(env, "DEVNET_BANKS")),
      devnetSeed: read(env, "DEVNET_SEED") ?? DEFAULT_DEVNET_SEED,
      allowHttp: true,
    },
  ];
  const testnetRpc = read(env, "TESTNET_RPC_URL") ?? DEFAULT_TESTNET_RPC;
  networks.push({
    id: "testnet",
    label: "Testnet",
    rpcUrl: testnetRpc,
    passphrase: PASSPHRASES.testnet,
    friendbotUrl: read(env, "TESTNET_FRIENDBOT_URL") ?? TESTNET_FRIENDBOT,
    ...optional("contractId", read(env, "TESTNET_CONTRACT_ID")),
    ...optional("centralBank", read(env, "TESTNET_CENTRAL_BANK")),
    banks: parseBanks(read(env, "TESTNET_BANKS")),
    allowHttp: isLocal(testnetRpc),
  });
  if (mainnetEnabled(env)) {
    const mainnetRpc = read(env, "MAINNET_RPC_URL") ?? "";
    networks.push({
      id: "mainnet",
      label: "Mainnet",
      rpcUrl: mainnetRpc,
      passphrase: PASSPHRASES.mainnet,
      ...optional("contractId", read(env, "MAINNET_CONTRACT_ID")),
      ...optional("centralBank", read(env, "MAINNET_CENTRAL_BANK")),
      banks: parseBanks(read(env, "MAINNET_BANKS")),
      allowHttp: false,
    });
  }
  return networks;
}

/** The network to select first: `VITE_RTGS_DEFAULT_NETWORK` if offered and not mainnet, else devnet. */
export function defaultNetwork(networks: NetworkConfig[], env: Env = {}): NetworkConfig {
  const wanted = read(env, "DEFAULT_NETWORK");
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
