// A fake session and store for component tests: the shapes core's React hooks read, with a
// scripted scenario. Nothing touches the network.
import { allAvailable, type BankView, type Capabilities, type FeedEvent, type NetworkConfig, type PaymentRecord, type RtgsSession, type SystemSnapshot } from "@rtgs/core";
import { vi } from "vitest";
import { A, B, C, CB, CONTRACT, deposited, settled, submitted, transfer, tx } from "./events.ts";

/** Whole units of the cash token, in stroops. */
export const u = (n: number) => BigInt(n) * 10_000_000n;

const NAMES = new Map([
  [A, "Bank A"],
  [B, "Bank B"],
  [C, "Bank C"],
]);

export const CONFIG = { queueCap: 16, expirySecs: 3_600, repoTermSecs: 86_400, penaltyRateBps: 500 };

/**
 * A queues 300 to B and B queues 200 to C, both uncovered. C queues 1000 urgent (uncovered) and
 * 10 normal behind it. Then A deposits 300: the eager closure settles #0, whose credit to B
 * releases #1.
 */
export function cascadeScenario() {
  const t0 = tx(100, (m) => [submitted(m(), 0n, A, B, u(300))]);
  const t1 = tx(101, (m) => [submitted(m(), 1n, B, C, u(200), "urgent")]);
  const t2 = tx(102, (m) => [submitted(m(), 2n, C, A, u(1000), "urgent")]);
  const t3 = tx(102, (m) => [submitted(m(), 3n, C, B, u(10))]);
  const t4 = tx(103, (m) => [transfer(m(), A, CONTRACT, u(300)), deposited(m(), A, u(300)), settled(m(), 0n, A, B, u(300)), settled(m(), 1n, B, C, u(200))]);
  const events: FeedEvent[] = [...t0, ...t1, ...t2, ...t3, ...t4];

  const at = (e: FeedEvent) => ({ eventId: e.eventId, ledger: e.ledger, closedAt: e.closedAt, txHash: e.txHash });
  const p2 = { id: 2n, from: C, to: A, amount: u(1000), priority: "urgent" as const, submittedAt: t2[0]!.closedAt, status: "queued" as const };
  const p3 = { id: 3n, from: C, to: B, amount: u(10), priority: "normal" as const, submittedAt: t3[0]!.closedAt, status: "queued" as const };
  const payments = new Map<bigint, PaymentRecord>([
    [
      0n,
      {
        id: 0n,
        from: A,
        to: B,
        amount: u(300),
        priority: "normal",
        submittedAt: t0[0]!.closedAt,
        status: "settled",
        settledAt: t4[0]!.closedAt,
        steps: [
          { kind: "submitted", priority: "normal", ...at(t0[0]!) },
          { kind: "settled", via: "eager-closure", trigger: { type: "Deposited", actor: A }, ...at(t4[2]!) },
        ],
      },
    ],
    [
      1n,
      {
        id: 1n,
        from: B,
        to: C,
        amount: u(200),
        priority: "urgent",
        submittedAt: t1[0]!.closedAt,
        status: "settled",
        settledAt: t4[0]!.closedAt,
        steps: [
          { kind: "submitted", priority: "urgent", ...at(t1[0]!) },
          { kind: "settled", via: "eager-closure", trigger: { type: "Deposited", actor: A }, ...at(t4[3]!) },
        ],
      },
    ],
    [2n, { ...p2, steps: [{ kind: "submitted", priority: "urgent", ...at(t2[0]!) }] }],
    [3n, { ...p3, steps: [{ kind: "submitted", priority: "normal", ...at(t3[0]!) }] }],
  ]);
  const view = (address: string, balance: bigint, urgent: (typeof p2)[], normal: (typeof p3)[], blocked: boolean): BankView => ({
    address,
    name: NAMES.get(address)!,
    balance,
    queues: { urgent, normal },
    analysis: {
      urgent: { priority: "urgent", length: urgent.length, covered: !blocked, ...(urgent[0] ? { head: urgent[0], blockedBy: "uncovered" as const } : {}) },
      normal: { priority: "normal", length: normal.length, covered: true, ...(normal[0] ? { head: normal[0], blockedBy: "urgent-queued" as const } : {}) },
    },
  });
  const banks = new Map<string, BankView>([
    [A, view(A, 0n, [], [], false)],
    [B, view(B, u(100), [], [], false)],
    [C, view(C, u(200), [p2], [p3], true)],
  ]);
  return { events, payments, banks, lastLedger: 103, lastCloseTime: t4[0]!.closedAt };
}

export function snapshotOf(scenario = cascadeScenario(), patch: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    status: "ready",
    contractId: CONTRACT,
    centralBank: CB,
    capabilities: stubbedCapabilities(),
    config: CONFIG,
    queuedCount: 2,
    banks: scenario.banks,
    payments: scenario.payments,
    repos: new Map(),
    collateral: new Map(),
    events: scenario.events,
    registry: [...NAMES].map(([address, name]) => ({ address, name, sources: ["devnet" as const] })),
    feed: {
      state: "live",
      clamped: false,
      startLedger: 90,
      oldestLedger: 90,
      oldestLedgerCloseTime: 1_800_000_450,
      latestLedger: scenario.lastLedger,
      latestLedgerCloseTime: scenario.lastCloseTime,
    },
    ledger: { sequence: scenario.lastLedger, closeTime: scenario.lastCloseTime },
    ...patch,
  };
}

/** What today's contract implements: credit (its entry points and views) is still stubbed. */
export function stubbedCapabilities(): Capabilities {
  return { ...allAvailable(), setCollateral: "stub", openRepo: "stub", repay: "stub", convertOverdue: "stub", credit: "stub", repo: "stub" };
}

export function fakeSession(snapshot: SystemSnapshot = snapshotOf(), network: Partial<NetworkConfig> = {}) {
  let current = snapshot;
  const listeners = new Set<() => void>();
  const store = {
    getSnapshot: () => current,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    refresh: vi.fn(),
  };
  const read = { payment: vi.fn(async (_id: bigint) => undefined as unknown) };
  const session = {
    network: { id: "devnet", label: "Devnet (local)", rpcUrl: "http://localhost:8300/rpc", passphrase: "x", banks: [], allowHttp: true, ...network },
    contractId: CONTRACT,
    centralBank: CB,
    cashToken: { code: "USD", issuer: CB, sacId: "CSAC" },
    get capabilities() {
      return current.capabilities;
    },
    registry: {
      nameOf: (a: string) => (a === CB ? "Central bank" : (NAMES.get(a) ?? `${a.slice(0, 4)}…${a.slice(-4)}`)),
      get: (a: string) => current.registry.find((b) => b.address === a),
      list: () => current.registry,
    },
    read,
    store: vi.fn(() => ({ store, release: vi.fn() })),
  };
  return {
    session: session as unknown as RtgsSession,
    read,
    set(patch: Partial<SystemSnapshot>) {
      current = { ...current, ...patch };
      for (const l of listeners) l();
    },
  };
}
