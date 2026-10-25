// Fakes every ticket's unit tests share: a world built from plain data, actors that record
// their calls, and a transaction outcome. No RPC.
import { allAvailable } from "@rtgs/core";
import type { Capabilities, Config, Payment, Repo, RtgsActor, RtgsEvent, TokenAdmin, TxOutcome } from "@rtgs/core";
import type { Actors, BankState, Tuning, World } from "../src/types.ts";

export const CB = "GCENTRALBANK";
export const CONTRACT = "CSETTLEMENT";
export const BANK_1 = "GBANK1";
export const BANK_2 = "GBANK2";
export const BANK_3 = "GBANK3";

/** 1 USD in stroops. */
export const USD = 10_000_000n;

export const CONFIG: Config = { queueCap: 16, expirySecs: 86_400, repoTermSecs: 86_400, penaltyRateBps: 500 };

export const TUNING: Tuning = {
  paymentSize: { min: 10n * USD, max: 500n * USD },
  queueHeadroom: 2,
  holdingFloor: 1_000n * USD,
  holdingCeiling: 20_000n * USD,
  deauthorizeSecs: 30,
  collateral: { min: 1_000n * USD, max: 5_000n * USD },
  submitMix: { covered: 6, uncovered: 3, gridlock: 1 },
};

export function bank(address: string, over: Partial<BankState> = {}): BankState {
  return {
    address,
    label: `Bank ${address.slice(-1)}`,
    balance: 1_000n * USD,
    holding: 5_000n * USD,
    authorized: true,
    queues: { urgent: [], normal: [] },
    ...over,
  };
}

let nextId = 0n;
export function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: nextId++,
    from: BANK_1,
    to: BANK_2,
    amount: 100n * USD,
    priority: "normal",
    submittedAt: 1_000,
    status: "queued",
    ...over,
  };
}

export interface FakeWorldState {
  now: number;
  config: Config;
  capabilities: Capabilities;
  banks: BankState[];
  repos: Repo[];
  /** Defaults to the number of queued payment orders in `banks`. */
  queuedCount?: number;
}

/** A world over mutable plain data: change `state` between calls to move time or balances. */
export function fakeWorld(over: Partial<FakeWorldState> = {}): World & { state: FakeWorldState; refreshed: string[][] } {
  const state: FakeWorldState = {
    now: 1_000,
    config: CONFIG,
    capabilities: allAvailable(),
    banks: [bank(BANK_1), bank(BANK_2), bank(BANK_3)],
    repos: [],
    ...over,
  };
  const queued = (from?: string) =>
    state.banks
      .filter((b) => from === undefined || b.address === from)
      .flatMap((b) => [...b.queues.urgent, ...b.queues.normal])
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const refreshed: string[][] = [];
  return {
    state,
    refreshed,
    centralBank: CB,
    contractId: CONTRACT,
    now: () => state.now,
    config: () => state.config,
    capabilities: () => state.capabilities,
    queuedCount: () => state.queuedCount ?? queued().length,
    banks: () => state.banks,
    bank: (address) => state.banks.find((b) => b.address === address),
    queuedPayments: queued,
    repos: (b) => state.repos.filter((r) => r.status !== "repaid" && (b === undefined || r.bank === b)),
    start: async () => {},
    refresh: async (addresses) => {
      refreshed.push([...addresses]);
    },
    stop: () => {},
  };
}

export function txOutcome<T>(value: T, events: RtgsEvent[] = []): TxOutcome<T> {
  return { txHash: "ab".repeat(32), ledger: 100, closedAt: 1_000, value, events };
}

export interface Call {
  /** The signer's address, or "token-admin". */
  as: string;
  method: string;
  args: unknown[];
}

/**
 * Actors whose every method records its call and resolves with `respond(call)`, by default
 * an outcome with value undefined. Throw from `respond` to simulate a refusal.
 */
export function fakeActors(respond: (call: Call) => TxOutcome<unknown> = () => txOutcome(undefined)): Actors & { calls: Call[] } {
  const calls: Call[] = [];
  const recorder = <T extends object>(as: string): T =>
    new Proxy({} as T, {
      get: (_t, method) =>
        method === "address"
          ? as
          : async (...args: unknown[]) => {
              const call = { as, method: String(method), args };
              calls.push(call);
              return respond(call);
            },
    });
  return {
    calls,
    bank: (address) => recorder<RtgsActor>(address),
    centralBank: recorder<RtgsActor>(CB),
    tokenAdmin: recorder<TokenAdmin>("token-admin"),
  };
}
