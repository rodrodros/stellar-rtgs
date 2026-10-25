import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RtgsError, allAvailable } from "@rtgs/core";
import type { BankView, Holding, PaymentRecord, Repo, RtgsSession, SystemSnapshot } from "@rtgs/core";
import { BANK_1, BANK_2, BANK_3, CB, CONFIG, CONTRACT, USD, payment } from "../../test/fakes.ts";
import { createWorld } from "./index.ts";

const BANKS = [
  { address: BANK_1, label: "Bank 1" },
  { address: BANK_2, label: "Bank 2" },
  { address: BANK_3, label: "Bank 3" },
];

function view(address: string, over: Partial<BankView> = {}): BankView {
  return { address, balance: 1_000n * USD, queues: { urgent: [], normal: [] }, analysis: {} as BankView["analysis"], ...over };
}

function holding(balance: bigint, authorized = true): Holding {
  return { balance, exists: true, authorized, authorizedToMaintainLiabilities: false, clawbackEnabled: true };
}

function repo(over: Partial<Repo> = {}): Repo {
  return { id: 0n, bank: BANK_1, amount: 100n * USD, outstanding: 100n * USD, openedAt: 1_000, status: "intraday", rateBps: 0, ...over };
}

function ready(over: Partial<SystemSnapshot> = {}): Partial<SystemSnapshot> {
  return {
    status: "ready",
    config: CONFIG,
    ledger: { sequence: 10, closeTime: 1_000 },
    banks: new Map(BANKS.map((b) => [b.address, view(b.address)])),
    ...over,
  };
}

/** A store you drive with `set`, and a session around it whose trustline reads you control. */
function fakeSession() {
  let snapshot: SystemSnapshot = {
    status: "loading",
    contractId: CONTRACT,
    centralBank: CB,
    capabilities: allAvailable(),
    queuedCount: 0,
    banks: new Map(),
    payments: new Map(),
    repos: new Map(),
    collateral: new Map(),
    events: [],
    registry: [],
    feed: { state: "idle", clamped: false },
  };
  const listeners = new Set<() => void>();
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const set = (patch: Partial<SystemSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const l of [...listeners]) l();
  };
  const holdings = new Map<string, Holding>(BANKS.map((b) => [b.address, holding(5_000n * USD)]));
  const release = vi.fn();
  const holdingRead = vi.fn(async (address: string) => holdings.get(address) ?? holding(0n, false));
  const session = {
    centralBank: CB,
    contractId: CONTRACT,
    store: vi.fn(() => ({ store, release })),
    token: { holding: holdingRead },
  } as unknown as RtgsSession;
  return { session, set, holdings, release, holdingRead, listeners };
}

async function started(over: Partial<SystemSnapshot> = {}) {
  const fake = fakeSession();
  fake.set(ready(over));
  const world = createWorld(fake.session, BANKS);
  await world.start();
  return { ...fake, world };
}

describe("createWorld", () => {
  describe("start", () => {
    it("waits for the store to be ready, then reads every bank's trustline", async () => {
      const fake = fakeSession();
      const world = createWorld(fake.session, BANKS);
      let done = false;
      const starting = world.start().then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
      expect(fake.holdingRead).not.toHaveBeenCalled();

      fake.set(ready());
      await starting;
      expect(fake.holdingRead.mock.calls.map((c) => c[0]).sort()).toEqual([BANK_1, BANK_2, BANK_3].sort());
      expect(world.bank(BANK_1)?.holding).toBe(5_000n * USD);
    });

    describe("timing out", () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it("rejects with the store's error, and releases the store", async () => {
        const fake = fakeSession();
        const world = createWorld(fake.session, BANKS, { readyTimeoutMs: 5_000 });
        const error = new RtgsError("rpc", "RPC unreachable", "Connection refused.");
        fake.set({ status: "error", error });
        const starting = world.start();
        const caught = starting.catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(4_999);
        fake.set({ status: "loading" });
        await vi.advanceTimersByTimeAsync(1);
        expect(await caught).toBe(error);
        expect(fake.release).toHaveBeenCalledTimes(1);
        expect(fake.listeners.size).toBe(0);
      });

      it("rejects with a timeout when the store reported no error", async () => {
        const fake = fakeSession();
        const world = createWorld(fake.session, BANKS, { readyTimeoutMs: 1_000 });
        const caught = world.start().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await caught).toMatchObject({ title: "World not ready" });
        expect(fake.release).toHaveBeenCalledTimes(1);
      });
    });

    it("rejects at once when stopped while waiting for the store", async () => {
      const fake = fakeSession();
      const world = createWorld(fake.session, BANKS);
      const starting = world.start();
      world.stop();
      await expect(starting).rejects.toMatchObject({ title: "World stopped" });
      expect(fake.release).toHaveBeenCalledTimes(1);
      expect(fake.listeners.size).toBe(0);
    });

    it("rejects when a trustline read fails", async () => {
      const fake = fakeSession();
      fake.set(ready());
      fake.holdingRead.mockRejectedValueOnce(new RtgsError("rpc", "RPC failed", "Timeout."));
      await expect(createWorld(fake.session, BANKS).start()).rejects.toMatchObject({ title: "RPC failed" });
      expect(fake.release).toHaveBeenCalledTimes(1);
    });
  });

  describe("the view", () => {
    it("maps every field of a bank, in the order passed, with the labels passed", async () => {
      const credit = { intraday: 50n * USD, penalty: 0n, collateral: 2_000n * USD };
      const urgent = payment({ from: BANK_2, priority: "urgent" });
      const normal = payment({ from: BANK_2 });
      const fake = fakeSession();
      fake.holdings.set(BANK_2, holding(7n * USD, false));
      fake.set(
        ready({
          banks: new Map([
            [BANK_3, view(BANK_3)],
            [BANK_2, view(BANK_2, { balance: 42n * USD, queues: { urgent: [urgent], normal: [normal] }, credit })],
            [BANK_1, view(BANK_1)],
          ]),
          collateral: new Map([[BANK_2, 2_000n * USD]]),
        }),
      );
      const world = createWorld(fake.session, BANKS);
      await world.start();
      expect(world.banks().map((b) => b.label)).toEqual(["Bank 1", "Bank 2", "Bank 3"]);
      expect(world.bank(BANK_2)).toEqual({
        address: BANK_2,
        label: "Bank 2",
        balance: 42n * USD,
        holding: 7n * USD,
        authorized: false,
        queues: { urgent: [urgent], normal: [normal] },
        credit,
        collateral: 2_000n * USD,
      });
      const b1 = world.bank(BANK_1)!;
      expect("credit" in b1).toBe(false);
      expect("collateral" in b1).toBe(false);
    });

    it("leaves out a bank the store hasn't read", async () => {
      const { world } = await started({ banks: new Map([[BANK_1, view(BANK_1)]]) });
      expect(world.banks().map((b) => b.address)).toEqual([BANK_1]);
      expect(world.bank(BANK_2)).toBeUndefined();
      expect(world.bank(CB)).toBeUndefined();
    });

    it("answers config, capabilities, the queued count and the parties", async () => {
      const capabilities = { ...allAvailable(), repo: "stub" as const };
      const { world } = await started({ capabilities, queuedCount: 7 });
      expect(world.config()).toBe(CONFIG);
      expect(world.capabilities()).toBe(capabilities);
      expect(world.queuedCount()).toBe(7);
      expect(world.centralBank).toBe(CB);
      expect(world.contractId).toBe(CONTRACT);
    });

    it("throws a clear error for config before it has been read, or before start", async () => {
      const { world } = await started({ config: undefined });
      expect(() => world.config()).toThrow(/config hasn't been read/);
      const unstarted = createWorld(fakeSession().session, BANKS);
      expect(() => unstarted.banks()).toThrow(/world.start\(\)/);
    });

    it("lists queued payment orders oldest first, all or one sender's", async () => {
      const a = payment({ id: 30n, from: BANK_1, priority: "urgent" });
      const b = payment({ id: 10n, from: BANK_1 });
      const c = payment({ id: 20n, from: BANK_2 });
      const { world } = await started({
        banks: new Map([
          [BANK_1, view(BANK_1, { queues: { urgent: [a], normal: [b] } })],
          [BANK_2, view(BANK_2, { queues: { urgent: [], normal: [c] } })],
          [BANK_3, view(BANK_3)],
        ]),
      });
      expect(world.queuedPayments().map((p) => p.id)).toEqual([10n, 20n, 30n]);
      expect(world.queuedPayments(BANK_1).map((p) => p.id)).toEqual([10n, 30n]);
      expect(world.queuedPayments(CB)).toEqual([]);
    });

    it("drops queued payment orders the events already show as final", async () => {
      const settled = payment({ id: 1n, from: BANK_1 });
      const queued = payment({ id: 2n, from: BANK_1 });
      const record = (p: typeof settled, status: PaymentRecord["status"]): PaymentRecord => ({ ...p, status, steps: [] });
      const { world } = await started({
        banks: new Map([[BANK_1, view(BANK_1, { queues: { urgent: [], normal: [settled, queued] } })]]),
        payments: new Map([
          [1n, record(settled, "settled")],
          [2n, record(queued, "queued")],
        ]),
      });
      expect(world.bank(BANK_1)?.queues.normal.map((p) => p.id)).toEqual([2n]);
      expect(world.queuedPayments().map((p) => p.id)).toEqual([2n]);
    });

    it("moves an order the events show as reprioritised into its new class, by age", async () => {
      const older = payment({ id: 5n, from: BANK_1, priority: "urgent" });
      const newer = payment({ id: 6n, from: BANK_1 });
      const { world } = await started({
        banks: new Map([[BANK_1, view(BANK_1, { queues: { urgent: [older], normal: [newer] } })]]),
        payments: new Map([
          [5n, { ...older, priority: "normal", steps: [] }],
          [6n, { ...newer, steps: [] }],
        ]),
      });
      const queues = world.bank(BANK_1)!.queues;
      expect(queues.urgent).toEqual([]);
      expect(queues.normal.map((p) => [p.id, p.priority])).toEqual([
        [5n, "normal"],
        [6n, "normal"],
      ]);
    });

    it("lists repos not repaid, all or one bank's, by id", async () => {
      const { world } = await started({
        repos: new Map([
          [2n, repo({ id: 2n, bank: BANK_2, status: "penalty" })],
          [0n, repo({ id: 0n, bank: BANK_1 })],
          [1n, repo({ id: 1n, bank: BANK_1, status: "repaid", outstanding: 0n })],
        ]),
      });
      expect(world.repos().map((r) => r.id)).toEqual([0n, 2n]);
      expect(world.repos(BANK_2).map((r) => r.id)).toEqual([2n]);
    });

    it("keeps the bank list until the snapshot's banks or a trustline change", async () => {
      const { world, set, holdings } = await started();
      const first = world.banks();
      set({ feed: { state: "live", clamped: false } });
      expect(world.banks()).toBe(first);

      set({ banks: new Map([[BANK_1, view(BANK_1, { balance: 1n })]]) });
      const second = world.banks();
      expect(second).not.toBe(first);
      expect(second[0]?.balance).toBe(1n);

      holdings.set(BANK_1, holding(9n));
      await world.refresh([BANK_1]);
      expect(world.banks()).not.toBe(second);
      expect(world.bank(BANK_1)?.holding).toBe(9n);
    });
  });

  describe("refresh", () => {
    it("re-reads the banks' trustlines and ignores the central bank and the contract", async () => {
      const { world, holdings, holdingRead } = await started();
      holdingRead.mockClear();
      holdings.set(BANK_2, holding(3n * USD, false));
      await world.refresh([BANK_2, CB, CONTRACT, BANK_2]);
      expect(holdingRead.mock.calls.map((c) => c[0])).toEqual([BANK_2]);
      expect(world.bank(BANK_2)).toMatchObject({ holding: 3n * USD, authorized: false });
    });

    it("keeps the newest read when an older one resolves later", async () => {
      const { world, holdingRead } = await started();
      let resolveOld!: (h: Holding) => void;
      holdingRead.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
      holdingRead.mockImplementationOnce(async () => holding(2n));
      const old = world.refresh([BANK_1]);
      await world.refresh([BANK_1]);
      resolveOld(holding(1n));
      await old;
      expect(world.bank(BANK_1)?.holding).toBe(2n);
    });

    it("does nothing before start or after stop", async () => {
      const fake = fakeSession();
      const world = createWorld(fake.session, BANKS);
      await world.refresh([BANK_1]);
      expect(fake.holdingRead).not.toHaveBeenCalled();
    });
  });

  describe("now", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("is the ledger's close time, advanced by wall time between ledgers", async () => {
      vi.setSystemTime(1_002_000); // 2 s after ledger 10 closed, at 1_000
      const { world, set } = await started();
      expect(world.now()).toBe(1_000);

      vi.setSystemTime(1_005_500);
      expect(world.now()).toBe(1_003);

      // A ledger reported with less lag tightens the estimate; one with more lag doesn't move it back.
      set({ ledger: { sequence: 11, closeTime: 1_005 } });
      expect(world.now()).toBe(1_005);
      vi.setSystemTime(1_009_000);
      set({ ledger: { sequence: 12, closeTime: 1_006 } });
      expect(world.now()).toBe(1_008);
    });

    it("never runs behind the latest ledger", async () => {
      vi.setSystemTime(1_000_000);
      const { world, set } = await started();
      // A local clock that lags the ledger's.
      set({ ledger: { sequence: 11, closeTime: 1_010 } });
      expect(world.now()).toBe(1_010);
    });
  });

  describe("stop", () => {
    it("releases the store once, however often it is called", async () => {
      const { world, release, listeners, holdingRead } = await started();
      world.stop();
      world.stop();
      expect(release).toHaveBeenCalledTimes(1);
      expect(listeners.size).toBe(0);
      holdingRead.mockClear();
      await world.refresh([BANK_1]);
      expect(holdingRead).not.toHaveBeenCalled();
    });

    it("is safe before start", () => {
      const fake = fakeSession();
      createWorld(fake.session, BANKS).stop();
      expect(fake.release).not.toHaveBeenCalled();
    });
  });
});
