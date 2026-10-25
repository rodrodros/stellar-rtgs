// End to end against a running devnet (stellar-implementation's `make devnet-up`):
//   IMPL_NAME=impl-fe-core IMPL_PORT=8350 make -C ../stellar-implementation devnet-up
//   RTGS_DEVNET_RPC=http://localhost:8350/rpc pnpm test:e2e
// Each run uses a fresh seed, so it bootstraps its own central bank, banks and contract.
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapDevnet,
  connect,
  devnetIdentities,
  keypairSigner,
  loadNetworks,
  parseAmount,
  PASSPHRASES,
  withOverrides,
  type Deployment,
  type DevnetIdentities,
  type FeedEvent,
  type NetworkConfig,
  type RtgsSession,
} from "../src/index.ts";
import { readSettlementWasm } from "../src/node/index.ts";

const RPC = process.env.RTGS_DEVNET_RPC ?? "http://localhost:8350/rpc";
/** lib.sh's config, but with a 10-second expiry so a keeper can reject a payment in the test. */
const CONFIG = { queueCap: 16, expirySecs: 10, repoTermSecs: 86_400, penaltyRateBps: 500 };

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
if (!up) console.warn(`e2e: skipped, no healthy devnet RPC at ${RPC} (set RTGS_DEVNET_RPC, run make devnet-up)`);

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!up)("@rtgs/core on the devnet", () => {
  const seed = `e2e-${Date.now()}`;
  const net: NetworkConfig = { ...withOverrides(loadNetworks({})[0]!, { rpcUrl: RPC }), devnetSeed: seed };
  let deployment: Deployment;
  let ids: DevnetIdentities;
  let session: RtgsSession;
  const steps: string[] = [];

  beforeAll(async () => {
    deployment = await bootstrapDevnet({
      network: net,
      wasm: await readSettlementWasm(),
      config: CONFIG,
      banks: 3,
      onStep: (s) => steps.push(`${s.status} ${s.step}`),
    });
    ids = devnetIdentities(net, 3);
    session = await connect(net);
  });

  afterAll(() => session?.dispose());

  it("bootstraps every step, issuing the cash token from the central bank", () => {
    expect(steps.filter((s) => s.startsWith("done"))).toEqual(
      ["fund", "issuer-flags", "sac", "banks", "contract", "authorize-contract", "publish"].map((s) => `done ${s}`),
    );
    expect(deployment.cashToken.issuer).toBe(ids.centralBank.address);
  });

  it("discovers the contract from the central bank's account and reads its token", () => {
    expect(session.contractId).toBe(deployment.contractId);
    expect(session.centralBank).toBe(ids.centralBank.address);
    expect(session.cashToken).toMatchObject({ sacId: deployment.sacId, code: "USD", issuer: ids.centralBank.address });
  });

  it("refuses an RPC that serves another network than the config says", async () => {
    await expect(connect({ ...net, id: "testnet", passphrase: PASSPHRASES.testnet })).rejects.toMatchObject({ kind: "network-mismatch" });
  });

  it("refuses mainnet without the app's confirmation", async () => {
    await expect(connect({ ...net, id: "mainnet", passphrase: PASSPHRASES.mainnet })).rejects.toMatchObject({
      kind: "mainnet-not-acknowledged",
    });
  });

  it("probes capabilities: what's implemented is available, todo!() stubs are stubs", async () => {
    const caps = session.capabilities;
    for (const name of ["deposit", "withdraw", "submit", "revoke", "reprioritise"] as const) expect(caps[name]).toBe("available");
    expect(Object.values(caps).every((c) => c === "available" || c === "stub")).toBe(true);
    const stub = (["expire", "setCollateral", "openRepo", "convertOverdue"] as const).find((n) => caps[n] === "stub");
    if (stub) {
      const actor = session.as(ids.centralBank);
      const preview =
        stub === "expire"
          ? await actor.simulate.expire(0n)
          : stub === "setCollateral"
            ? await actor.simulate.setCollateral(ids.banks[0]!.address, 1n)
            : stub === "openRepo"
              ? await actor.simulate.openRepo(ids.banks[0]!.address, 1n)
              : await actor.simulate.convertOverdue(0n);
      expect(preview).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
    }
  });

  it("lists the banks from the ledger registry, named, without the central bank", async () => {
    const banks = await session.registry.load();
    expect(banks.map((b) => b.address).sort()).toEqual(ids.banks.map((b) => b.address).sort());
    for (const b of banks) {
      expect(b.name).toMatch(/^Bank \d$/);
      expect(b.sources).toEqual(expect.arrayContaining(["ledger", "devnet"]));
    }
  });

  it("refuses a signer bound to another network, and a token admin that isn't the issuer", () => {
    const foreign = { ...keypairSigner(Keypair.random(), net), networkPassphrase: PASSPHRASES.testnet };
    expect(() => session.as(foreign)).toThrow(/another network/);
    expect(() => session.tokenAdmin(ids.banks[0]!)).toThrow(/admin/);
  });

  it("maps a refused call to the contract's error", async () => {
    await expect(session.as(ids.banks[0]!).deposit(0n)).rejects.toMatchObject({ kind: "contract", code: 1, title: "Invalid amount" });
  });

  it("settles, queues, reprioritises, revokes and releases by the eager closure, as events and views agree", async () => {
    const [b1, b2, b3] = ids.banks.map((s) => session.as(s)) as [ReturnType<RtgsSession["as"]>, ReturnType<RtgsSession["as"]>, ReturnType<RtgsSession["as"]>];
    const start = await session.latestLedger();
    const feed = session.events({ from: { ledger: start.sequence }, pollMs: 500 });
    const seen: FeedEvent[] = [];
    feed.subscribe((batch) => seen.push(...batch));
    feed.start();

    const deposit = await b1.deposit(parseAmount("1000"));
    expect(deposit.events.map((e) => e.type)).toEqual(["Deposited"]);

    const atOnce = await b1.submit({ to: b2.address, amount: parseAmount("500"), priority: "urgent" });
    expect(atOnce.value.disposition).toBe("settled");

    // Bank 3 has no settlement balance, so its payments queue.
    const normal = await b3.submit({ to: b1.address, amount: parseAmount("200"), priority: "normal" });
    const urgent = await b3.submit({ to: b1.address, amount: parseAmount("100"), priority: "urgent" });
    expect([normal.value.disposition, urgent.value.disposition]).toEqual(["queued", "queued"]);

    let view = await session.read.bank(b3.address);
    expect(view.queues.urgent.map((p) => p.id)).toEqual([urgent.value.id]);
    expect(view.queues.normal.map((p) => p.id)).toEqual([normal.value.id]);
    expect(view.analysis.urgent.blockedBy).toBe("uncovered");
    expect(view.analysis.normal.blockedBy).toBe("urgent-queued");

    // Reprioritising keeps the older payment ahead of the newer one (A8, toEnd = false).
    await b3.reprioritise(normal.value.id, "urgent");
    expect(await session.read.queue(b3.address, "urgent")).toEqual([normal.value.id, urgent.value.id]);

    await b3.revoke(urgent.value.id);
    expect((await session.read.payment(urgent.value.id))?.status).toBe("revoked");

    // A deposit covers the head: the eager closure settles it in the same transaction.
    const release = await b3.deposit(parseAmount("250"));
    expect(release.events.map((e) => e.type)).toEqual(["Deposited", "Settled"]);
    expect((await session.read.payment(normal.value.id))?.status).toBe("settled");
    view = await session.read.bank(b3.address);
    expect(view.balance).toBe(parseAmount("50"));
    expect(view.queues.urgent).toEqual([]);

    // The feed delivers the same events, with the same ids, in order.
    const all = [...deposit.events, ...atOnce.events, ...normal.events, ...urgent.events, ...release.events];
    const last = release.events.at(-1)!;
    await waitFor("the feed to catch up", () => seen.some((e) => e.eventId === last.eventId));
    feed.stop();
    const fromFeed = seen.filter((e) => e.type !== "Token");
    for (const e of all) expect(fromFeed.find((f) => f.eventId === e.eventId)).toEqual(e);
    const types = fromFeed.map((e) => e.type);
    expect(types).toEqual(["Deposited", "Submitted", "Settled", "Submitted", "Submitted", "Reprioritised", "Revoked", "Deposited", "Settled"]);
    expect(feed.status()).toMatchObject({ clamped: false });

    // The cash token holdings moved with the deposits.
    expect(await session.token.balance(b1.address)).toBe(parseAmount("9000"));
    expect(await session.token.balance(session.contractId)).toBe(parseAmount("1250"));
  });

  it("keeps a store that converges with the views and explains each settlement", async () => {
    const { store, release } = session.store({ feed: { pollMs: 500 } });
    try {
      const snapshot = await waitFor("the store to load and replay", () => {
        const s = store.getSnapshot();
        return s.status === "ready" && s.events.some((e) => e.type === "Revoked") && s.banks.size === 3 ? s : undefined;
      });
      expect(snapshot.config).toEqual(CONFIG);
      expect(snapshot.queuedCount).toBe(0);
      for (const bank of ids.banks) {
        const live = await session.read.bank(bank.address);
        await waitFor(`${bank.label}'s balance`, () => store.getSnapshot().banks.get(bank.address)?.balance === live.balance);
      }
      const settled = [...snapshot.payments.values()].filter((p) => p.status === "settled");
      expect(settled).toHaveLength(2);
      const [first, second] = settled.sort((a, b) => Number(a.id - b.id));
      expect(first!.steps.map((s) => s.kind)).toEqual(["submitted", "settled"]);
      expect(first!.steps[1]).toMatchObject({ via: "at-once" });
      expect(second!.steps.map((s) => s.kind)).toEqual(["submitted", "reprioritised", "settled"]);
      expect(second!.steps.at(-1)).toMatchObject({ via: "eager-closure", trigger: { type: "Deposited", actor: ids.banks[2]!.address } });
      expect(snapshot.registry.map((b) => b.name).sort()).toEqual(["Bank 1", "Bank 2", "Bank 3"]);
    } finally {
      release();
    }
  });

  it("lets a keeper reject a queued payment once its expiry has passed (ADR-0015)", async (ctx) => {
    if (session.capabilities.expire !== "available") ctx.skip();
    const b3 = session.as(ids.banks[2]!);
    const keeper = session.as(ids.banks[0]!);
    const queued = await b3.submit({ to: ids.banks[0]!.address, amount: parseAmount("5000"), priority: "normal" });
    expect(queued.value.disposition).toBe("queued");
    const id = queued.value.id;
    expect(await keeper.simulate.expire(id)).toMatchObject({ ok: false, error: { kind: "contract", code: 9 } });

    const payment = (await session.read.payment(id))!;
    await (async () => {
      for (;;) {
        if ((await session.latestLedger()).closeTime > payment.submittedAt + CONFIG.expirySecs) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    const config = await session.read.config();
    const now = (await session.latestLedger()).closeTime;
    expect((await session.read.bank(ids.banks[2]!.address, { config, now })).analysis.normal).toMatchObject({ head: { id }, expired: true });

    const outcome = await keeper.expire(id);
    expect(outcome.events.map((e) => e.type)).toEqual(["Expired"]);
    expect((await session.read.payment(id))?.status).toBe("expired");
    expect(await session.read.queue(ids.banks[2]!.address, "normal")).toEqual([]);
  });
});
