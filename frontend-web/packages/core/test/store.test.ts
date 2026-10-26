import { afterEach, describe, expect, it, vi } from "vitest";
import { allAvailable } from "../src/capabilities.ts";
import type { FeedStatus } from "../src/events/feed.ts";
import { RtgsStore } from "../src/model/store.ts";
import type { BankView, RtgsSession } from "../src/session.ts";
import type { Config, FeedEvent, Payment } from "../src/types.ts";
import { A, B, CB, CONTRACT, meta } from "./helpers.ts";

const config: Config = { queueCap: 16, expirySecs: 100, repoTermSecs: 100, penaltyRateBps: 500 };
const view = (address: string, balance: bigint): BankView => ({
  address,
  balance,
  queues: { urgent: [], normal: [] },
  analysis: { urgent: { priority: "urgent", length: 0, covered: false }, normal: { priority: "normal", length: 0, covered: false } },
});

function fakeSession() {
  let onBatch: (batch: FeedEvent[]) => void = () => {};
  let onStatus: (s: FeedStatus) => void = () => {};
  const payments = new Map<bigint, Payment>();
  const session = {
    contractId: CONTRACT,
    centralBank: CB,
    capabilities: allAvailable(),
    latestLedger: async () => ({ sequence: 1, closeTime: 1000 }),
    read: {
      config: async () => config,
      queuedCount: async () => 0,
      latestPaymentId: vi.fn(async (): Promise<bigint | undefined> => undefined),
      payments: vi.fn(async (_range: { from: bigint; to: bigint }, _opts?: { onRead?: () => void }): Promise<Payment[]> => []),
      repo: async () => undefined,
      payment: vi.fn(async (id: bigint) => payments.get(id)),
      bank: vi.fn(async (address: string) => view(address, 0n)),
    },
    registry: {
      banks: [
        { address: A, sources: ["config"] },
        { address: B, sources: ["config"] },
      ] as { address: string; sources: string[] }[],
      listeners: new Set<(b: unknown[]) => void>(),
      list() {
        return this.banks;
      },
      load: vi.fn(async () => []),
      observe: () => [],
      get(address: string) {
        return this.banks.find((b) => b.address === address);
      },
      subscribe(fn: (b: unknown[]) => void) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      },
    },
    events: () => ({
      subscribe: (fn: typeof onBatch) => ((onBatch = fn), () => {}),
      onStatus: (fn: typeof onStatus) => ((onStatus = fn), () => {}),
      start: () => {},
      stop: () => {},
    }),
  };
  return {
    session: session as unknown as RtgsSession,
    read: session.read,
    registry: session.registry,
    payments,
    emit: (batch: FeedEvent[]) => onBatch(batch),
    status: (s: Partial<FeedStatus>) => onStatus({ state: "live", clamped: false, ...s }),
  };
}

async function ready(store: RtgsStore) {
  await vi.waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
}

afterEach(() => vi.useRealTimers());

describe("store", () => {
  it("can't be restarted once stopped", async () => {
    const fake = fakeSession();
    const store = new RtgsStore(fake.session);
    store.start();
    await ready(store);
    store.stop();
    expect(() => store.start()).toThrow(/stopped/i);
  });

  it("reads in full a payment order it knew only from an event", async () => {
    const fake = fakeSession();
    fake.payments.set(9n, { id: 9n, from: A, to: B, amount: 7n, priority: "urgent", submittedAt: 3, status: "settled", settledAt: 900 });
    const store = new RtgsStore(fake.session, { refreshDebounceMs: 1 });
    store.start();
    await ready(store);
    fake.emit([{ ...meta(10), type: "Settled", id: 9n, from: A, to: B, amount: 7n }]);
    expect(store.getSnapshot().payments.get(9n)).toMatchObject({ partial: true });
    await vi.waitFor(() => expect(store.getSnapshot().payments.get(9n)).toMatchObject({ priority: "urgent", submittedAt: 3 }));
    expect(store.getSnapshot().payments.get(9n)!.partial).toBeUndefined();
    expect(fake.read.payment).toHaveBeenCalledWith(9n);
    store.stop();
  });

  it("applies refreshes in order, so a slow older read can't overwrite a newer one", async () => {
    const fake = fakeSession();
    const store = new RtgsStore(fake.session);
    store.start();
    await ready(store);
    let call = 0;
    fake.read.bank.mockImplementation(async (address: string) => {
      call += 1;
      const n = call;
      await new Promise((r) => setTimeout(r, n === 1 ? 50 : 1));
      return view(address, BigInt(n));
    });
    await Promise.all([store.refresh([A]), store.refresh([A])]);
    expect(store.getSnapshot().banks.get(A)!.balance).toBe(2n);
    store.stop();
  });

  it("keeps the same ledger object until a new ledger closes", async () => {
    const fake = fakeSession();
    const store = new RtgsStore(fake.session);
    store.start();
    await ready(store);
    fake.status({ latestLedger: 5, latestLedgerCloseTime: 1020 });
    const first = store.getSnapshot().ledger;
    fake.status({ latestLedger: 5, latestLedgerCloseTime: 1020 });
    expect(store.getSnapshot().ledger).toBe(first);
    fake.status({ latestLedger: 6, latestLedgerCloseTime: 1025 });
    expect(store.getSnapshot().ledger).toEqual({ sequence: 6, closeTime: 1025 });
    store.stop();
  });

  it("stops refreshing once stopped", async () => {
    const fake = fakeSession();
    const store = new RtgsStore(fake.session, { refreshDebounceMs: 1 });
    store.start();
    await ready(store);
    const calls = fake.read.bank.mock.calls.length;
    fake.emit([{ ...meta(10), type: "Deposited", bank: A, amount: 1n }]);
    store.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.read.bank.mock.calls.length).toBe(calls);
  });

  it("re-reads the bank of a repo that is repaid or penalised, though neither event names it", async () => {
    const fake = fakeSession();
    const store = new RtgsStore(fake.session, { refreshDebounceMs: 1 });
    store.start();
    await ready(store);
    fake.emit([{ ...meta(10), type: "RepoOpened", id: 0n, bank: B, amount: 30n }]);
    await vi.waitFor(() => expect(fake.read.bank).toHaveBeenLastCalledWith(B, expect.anything()));
    fake.read.bank.mockClear();
    fake.emit([{ ...meta(11), type: "RepoRepaid", id: 0n, amount: 10n, outstanding: 20n }]);
    await vi.waitFor(() => expect(fake.read.bank).toHaveBeenCalledWith(B, expect.anything()));
    fake.read.bank.mockClear();
    fake.emit([{ ...meta(12), type: "RepoPenalised", id: 0n, rateBps: 500 }]);
    await vi.waitFor(() => expect(fake.read.bank).toHaveBeenCalledWith(B, expect.anything()));
    store.stop();
  });

  it("tries a failed initial load again, and retry() does it at once", async () => {
    const fake = fakeSession();
    const config = fake.read.config;
    let failures = 2;
    fake.read.config = vi.fn(async () => {
      if (failures-- > 0) throw new TypeError("fetch failed");
      return config();
    });
    const store = new RtgsStore(fake.session);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ status: "error", error: { kind: "rpc" } }));
    store.retry();
    await vi.waitFor(() => expect(fake.read.config).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 5)); // let the second failure land
    store.retry();
    await ready(store);
    store.stop();
  });

  it("gives a bank new to the registry its views, and re-reads the registry periodically", async () => {
    const fake = fakeSession();
    const store = new RtgsStore(fake.session, { refreshDebounceMs: 1, registryPollMs: 20 });
    store.start();
    await ready(store);
    const C = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
    fake.registry.banks.push({ address: C, sources: ["ledger"] });
    for (const l of fake.registry.listeners) l(fake.registry.banks);
    await vi.waitFor(() => expect(store.getSnapshot().banks.has(C)).toBe(true));
    await vi.waitFor(() => expect(fake.registry.load.mock.calls.length).toBeGreaterThanOrEqual(3));
    store.stop();
  });

  it("drops the view of a bank that left the registry and follows renames", async () => {
    const fake = fakeSession();
    const store = new RtgsStore(fake.session, { refreshDebounceMs: 1 });
    store.start();
    await ready(store);
    expect(store.getSnapshot().banks.has(B)).toBe(true);
    fake.registry.banks = [{ address: A, name: "Renamed", sources: ["ledger"] } as never];
    for (const l of fake.registry.listeners) l(fake.registry.banks);
    expect(store.getSnapshot().banks.has(B)).toBe(false);
    expect(store.getSnapshot().banks.get(A)!.name).toBe("Renamed");
    store.stop();
  });

  it("doesn't bring back a bank that left the registry while its views were being read", async () => {
    const fake = fakeSession();
    const store = new RtgsStore(fake.session, { refreshDebounceMs: 1 });
    store.start();
    await ready(store);
    fake.read.bank.mockImplementation(async (address: string) => {
      await new Promise((r) => setTimeout(r, 30));
      return view(address, 1n);
    });
    const refreshing = store.refresh();
    fake.registry.banks = [{ address: A, sources: ["config"] }];
    for (const l of fake.registry.listeners) l(fake.registry.banks);
    expect(store.getSnapshot().banks.has(B)).toBe(false);
    await refreshing;
    expect(store.getSnapshot().banks.has(B)).toBe(false);
    store.stop();
  });

  it("reports a registry read failure apart from the load, until a read succeeds", async () => {
    const fake = fakeSession();
    fake.registry.load.mockRejectedValueOnce(new TypeError("fetch failed"));
    const store = new RtgsStore(fake.session, { registryPollMs: 300 });
    store.start();
    await ready(store);
    expect(store.getSnapshot().registryError).toMatchObject({ kind: "rpc" });
    expect(store.getSnapshot().error).toBeUndefined();
    await vi.waitFor(() => expect(store.getSnapshot().registryError).toBeUndefined());
    store.stop();
  });

  it("reports the initial load's progress, and shows the registry's banks before reading the payment orders", async () => {
    const fake = fakeSession();
    const C = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
    fake.registry.load.mockImplementation(async () => {
      fake.registry.banks = [...fake.registry.banks, { address: C, sources: ["ledger"] }];
      return [];
    });
    let release!: () => void;
    const views = new Promise<void>((r) => (release = r));
    fake.read.bank.mockImplementation(async (address: string) => {
      await views;
      return view(address, 0n);
    });
    fake.read.latestPaymentId.mockResolvedValue(2n);
    fake.read.payments.mockImplementation(async (range, opts) => {
      for (let id = range.from; id <= range.to; id++) opts?.onRead?.();
      return [];
    });
    const store = new RtgsStore(fake.session);
    const steps: string[] = [];
    store.subscribe(() => {
      const p = store.getSnapshot().loading;
      const step = p && `${p.index + 1}/${p.count} ${p.step}${p.total === undefined ? "" : ` ${p.done}/${p.total}`}`;
      if (step && steps.at(-1) !== step) steps.push(step);
    });
    store.start();
    await vi.waitFor(() => expect(fake.read.bank).toHaveBeenCalledTimes(3));
    expect(store.getSnapshot().registry.map((b) => b.address)).toContain(C);
    expect(fake.read.latestPaymentId).not.toHaveBeenCalled();
    release();
    await ready(store);
    expect(store.getSnapshot().loading).toBeUndefined();
    expect(steps).toEqual([
      "1/5 config",
      "2/5 registry",
      "3/5 banks 0/3",
      "3/5 banks 1/3",
      "3/5 banks 2/3",
      "3/5 banks 3/3",
      "4/5 payments",
      "4/5 payments 0/3",
      "4/5 payments 1/3",
      "4/5 payments 2/3",
      "4/5 payments 3/3",
      "5/5 repos",
    ]);
    store.stop();
  });

  it("leaves out the repos step when the contract doesn't implement repos", async () => {
    const fake = fakeSession();
    (fake.session as { capabilities: object }).capabilities = { ...allAvailable(), repo: "stub" };
    const store = new RtgsStore(fake.session);
    const counts = new Set<number>();
    store.subscribe(() => {
      const p = store.getSnapshot().loading;
      if (p) counts.add(p.count);
    });
    store.start();
    await ready(store);
    expect([...counts]).toEqual([4]);
    store.stop();
  });
});
