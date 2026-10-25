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
      latestPaymentId: async () => undefined,
      payments: async () => [],
      repo: async () => undefined,
      payment: vi.fn(async (id: bigint) => payments.get(id)),
      bank: vi.fn(async (address: string) => view(address, 0n)),
    },
    registry: {
      list: () => [{ address: A, sources: ["config"] }, { address: B, sources: ["config"] }],
      load: async () => [],
      observe: () => [],
      get: () => undefined,
      subscribe: () => () => {},
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
});
