// The observer's pipeline end to end against a running devnet: core's session, store and event
// feed, then the observer's own models (timeline causes, flows). Writes happen in this test
// only, through core's devnet identities; the app itself never signs.
//   IMPL_NAME=impl-fe-observer IMPL_PORT=8380 make -C ../stellar-implementation devnet-up
//   RTGS_DEVNET_RPC=http://localhost:8380/rpc pnpm --filter @rtgs/observer test:e2e
import {
  bootstrapDevnet,
  connect,
  devnetIdentities,
  flowMatrix,
  loadNetworks,
  parseAmount,
  withOverrides,
  type DevnetIdentities,
  type NetworkConfig,
  type RtgsSession,
  type RtgsStore,
  type SystemSnapshot,
} from "@rtgs/core";
import { readSettlementWasm } from "@rtgs/core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cell } from "../src/model/flows.ts";
import { groupByTransaction } from "../src/model/timeline.ts";

const RPC = process.env.RTGS_DEVNET_RPC ?? "http://localhost:8300/rpc";

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    return ((await res.json()) as { result?: { status?: string } }).result?.status === "healthy";
  } catch {
    return false;
  }
}

const up = await healthy();
if (!up) console.warn(`observer e2e: skipped, no healthy devnet RPC at ${RPC} (set RTGS_DEVNET_RPC, run make devnet-up)`);

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!up)("the observer on the devnet", () => {
  const net: NetworkConfig = { ...withOverrides(loadNetworks({})[0]!, { rpcUrl: RPC }), devnetSeed: `observer-e2e-${Date.now()}` };
  let ids: DevnetIdentities;
  let session: RtgsSession;
  let store: RtgsStore;
  let release: () => void;
  const order: Record<string, bigint> = {};

  beforeAll(async () => {
    await bootstrapDevnet({ network: net, wasm: await readSettlementWasm(), banks: 3 });
    ids = devnetIdentities(net, 3);
    session = await connect(net);
    const start = await session.latestLedger();
    ({ store, release } = session.store({ feed: { from: { ledger: start.sequence }, pollMs: 500 }, refreshDebounceMs: 100 }));

    const [b1, b2, b3] = ids.banks.map((s) => session.as(s));
    // Neither bank has a settlement balance, so both payment orders queue.
    order.a = (await b1!.submit({ to: b2!.address, amount: parseAmount("300"), priority: "normal" })).value.id;
    order.b = (await b2!.submit({ to: b3!.address, amount: parseAmount("200"), priority: "normal" })).value.id;
    // Bank 1's deposit covers a; its credit to Bank 2 covers b, in the same transaction.
    await b1!.deposit(parseAmount("300"));
    // Bank 3's uncovered urgent payment order holds back its normal one, until it is revoked.
    order.urgent = (await b3!.submit({ to: b1!.address, amount: parseAmount("1000"), priority: "urgent" })).value.id;
    order.normal = (await b3!.submit({ to: b1!.address, amount: parseAmount("10"), priority: "normal" })).value.id;
    await b3!.revoke(order.urgent);
  });

  afterAll(() => {
    release?.();
    session?.dispose();
  });

  const settledSnapshot = () =>
    waitFor("the store to see every settlement and re-read the banks", () => {
      const s = store.getSnapshot();
      const done = s.payments.get(order.normal!)?.status === "settled" && [...s.banks.values()].every((b) => b.queues.urgent.length + b.queues.normal.length === 0);
      return done && s.banks.size === 3 ? s : undefined;
    });

  it("explains the cascade a deposit released, step by step", async () => {
    const s: SystemSnapshot = await settledSnapshot();
    const deposit = groupByTransaction(s.events).find((g) => g.trigger?.type === "Deposited")!;
    expect(deposit.trigger).toMatchObject({ bank: ids.banks[0]!.address });
    expect(deposit.settlements.map((x) => [x.event.id, x.via, x.releasedBy])).toEqual([
      [order.a, "eager-closure", { kind: "trigger" }],
      [order.b, "eager-closure", { kind: "payment", id: order.a }],
    ]);
    // Core's lifecycle agrees on how each settled.
    expect(s.payments.get(order.b!)!.steps.map((x) => x.kind)).toEqual(["submitted", "settled"]);
    expect(s.payments.get(order.b!)!.steps.at(-1)).toMatchObject({ via: "eager-closure", trigger: { type: "Deposited", actor: ids.banks[0]!.address } });
  });

  it("explains a settlement released by a revocation", async () => {
    const s = await settledSnapshot();
    const revocation = groupByTransaction(s.events).find((g) => g.trigger?.type === "Revoked")!;
    expect(revocation.settlements).toMatchObject([{ via: "eager-closure", releasedBy: { kind: "trigger" }, event: { id: order.normal } }]);
    expect(s.payments.get(order.urgent!)!.status).toBe("revoked");
  });

  it("shows balances, empty queues and the flows that settled", async () => {
    const s = await settledSnapshot();
    const [b1, b2, b3] = ids.banks.map((b) => b.address) as [string, string, string];
    await waitFor("the balances", () => store.getSnapshot().banks.get(b3)?.balance === parseAmount("190"));
    const banks = store.getSnapshot().banks;
    expect([b1, b2, b3].map((b) => banks.get(b)!.balance)).toEqual([parseAmount("10"), parseAmount("100"), parseAmount("190")]);
    expect(store.getSnapshot().queuedCount).toBe(0);
    const flows = flowMatrix(s.events);
    expect([cell(flows, b1, b2), cell(flows, b2, b3), cell(flows, b3, b1)]).toEqual([parseAmount("300"), parseAmount("200"), parseAmount("10")]);
  });

  it("reports the retention window and where the history starts", async () => {
    const { feed } = await settledSnapshot();
    expect(feed.clamped).toBe(false);
    expect(feed.oldestLedger).toBeLessThanOrEqual(feed.startLedger!);
    expect(feed.latestLedger).toBeGreaterThan(feed.startLedger!);
  });
});
