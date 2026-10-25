// Which entry points the deployed contract implements (spec fact 1). Each is simulated with
// harmless arguments: a `todo!()` stub traps (`Error(WasmVm, …)`), while an implemented entry
// point returns a value or refuses with a contract error. Nothing is sent, and the probe
// follows whatever Wasm is deployed, not the source.
import { rpc } from "@stellar/stellar-sdk";
import type { contract } from "@stellar/stellar-sdk";
import { isWasmTrap } from "./errors.ts";
import { fromPriority } from "./contract/convert.ts";
import { mapLimit, NO_ID, type SettlementReader } from "./contract/gateway.ts";
import { readEnv, type Env } from "./network/networks.ts";

export const ENTRY_POINTS = [
  "deposit",
  "withdraw",
  "submit",
  "revoke",
  "reprioritise",
  "expire",
  "setCollateral",
  "openRepo",
  "repay",
  "convertOverdue",
  "credit",
  "repo",
] as const;

export type EntryPoint = (typeof ENTRY_POINTS)[number];
export type Capability = "available" | "stub" | "unknown";
export type Capabilities = Record<EntryPoint, Capability>;

/** Classifies one simulation outcome. */
export function classify(simulation: rpc.Api.SimulateTransactionResponse | undefined, thrown?: unknown): Capability {
  if (thrown !== undefined) {
    const text = String(thrown instanceof Error ? thrown.message : thrown);
    if (isWasmTrap(text)) return "stub";
    if (/Error\(Contract, #\d+\)/.test(text)) return "available";
    return "unknown";
  }
  if (!simulation) return "unknown";
  if (rpc.Api.isSimulationError(simulation)) {
    if (isWasmTrap(simulation.error)) return "stub";
    if (/Error\(Contract, #\d+\)/.test(simulation.error)) return "available";
    return "unknown";
  }
  return "available";
}

type Probe = (c: SettlementReader["client"], someone: string) => Promise<contract.AssembledTransaction<unknown>>;

/** Each entry point with arguments it refuses or answers without changing anything. */
const PROBES: Record<EntryPoint, Probe> = {
  deposit: (c, a) => c.deposit({ bank: a, amount: 0n }),
  withdraw: (c, a) => c.withdraw({ bank: a, amount: 0n }),
  submit: (c, a) => c.submit({ from: a, to: a, amount: 0n, priority: fromPriority("normal") }),
  revoke: (c) => c.revoke({ id: NO_ID }),
  reprioritise: (c) => c.reprioritise({ id: NO_ID, priority: fromPriority("normal") }),
  expire: (c) => c.expire({ id: NO_ID }),
  setCollateral: (c, a) => c.set_collateral({ bank: a, value: -1n }),
  openRepo: (c, a) => c.open_repo({ bank: a, amount: 0n }),
  repay: (c, a) => c.repay({ actor: a, repo_id: NO_ID, amount: 0n }),
  convertOverdue: (c) => c.convert_overdue({ repo_id: NO_ID }),
  credit: (c, a) => c.credit({ bank: a }),
  repo: (c) => c.repo({ id: NO_ID }),
};

/** `"expire=available,credit=stub"`: forces capabilities, e.g. for a demo or a broken probe. */
export function parseCapabilityOverrides(text: string | undefined): Partial<Capabilities> {
  const overrides: Partial<Capabilities> = {};
  for (const item of (text ?? "").split(",")) {
    const [name, value] = item.split("=").map((s) => s.trim());
    if (ENTRY_POINTS.includes(name as EntryPoint) && (value === "available" || value === "stub")) {
      overrides[name as EntryPoint] = value;
    }
  }
  return overrides;
}

export function capabilityOverrides(env: Env): Partial<Capabilities> {
  return parseCapabilityOverrides(readEnv(env, "CAPABILITIES"));
}

/**
 * Probe results per network, contract and Wasm hash: the same code answers the same way, so a
 * reconnect or a network switch back doesn't repeat the 12 simulations.
 */
const probed = new Map<string, Capabilities>();

/** `probeCapabilities`, cached by `key` (passphrase, contract id and Wasm hash). */
export async function cachedCapabilities(
  key: string,
  reader: SettlementReader,
  someone: string,
  overrides: Partial<Capabilities> = {},
): Promise<Capabilities> {
  let caps = probed.get(key);
  if (!caps) {
    caps = await probeCapabilities(reader, someone);
    // Don't cache a probe that couldn't decide, e.g. during an RPC hiccup.
    if (!Object.values(caps).includes("unknown")) probed.set(key, caps);
  }
  return { ...caps, ...overrides };
}

/** `someone`: any address, e.g. the central bank. */
export async function probeCapabilities(
  reader: SettlementReader,
  someone: string,
  overrides: Partial<Capabilities> = {},
): Promise<Capabilities> {
  const verdicts = await mapLimit([...ENTRY_POINTS], 4, async (name) => {
    try {
      const tx = await PROBES[name](reader.client, someone);
      return classify(tx.simulation);
    } catch (e) {
      return classify(undefined, e);
    }
  });
  const caps = Object.fromEntries(ENTRY_POINTS.map((name, i) => [name, verdicts[i]!])) as Capabilities;
  return { ...caps, ...overrides };
}

export const allAvailable = (): Capabilities =>
  Object.fromEntries(ENTRY_POINTS.map((name) => [name, "available"])) as Capabilities;
