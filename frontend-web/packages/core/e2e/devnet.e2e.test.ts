// End to end against a running devnet (backend-soroban's `make devnet-up`):
//   IMPL_NAME=impl-fe-core IMPL_PORT=8350 make -C ../backend-soroban devnet-up
//   RTGS_DEVNET_RPC=http://localhost:8350/rpc pnpm test:e2e
// Each run uses a fresh seed, so it bootstraps its own central bank, banks and contract.
import { writeFileSync } from "node:fs";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { decodeBody } from "../src/events/decode.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allAvailable,
  bootstrapDevnet,
  connect,
  devnetIdentities,
  keypairSigner,
  loadNetworks,
  parseAmount,
  PASSPHRASES,
  isExpired,
  withOverrides,
  type Deployment,
  type DevnetIdentities,
  type FeedEvent,
  type NetworkConfig,
  type RtgsSession,
} from "../src/index.ts";
import { readSettlementWasm } from "../src/node/index.ts";

const RPC = process.env.RTGS_DEVNET_RPC ?? "http://localhost:8300/rpc";
/**
 * lib.sh's config, but with a 10-second expiry and repo term, so a keeper can reject a payment
 * and penalise a repo in the test.
 */
const CONFIG = { queueCap: 16, expirySecs: 10, repoTermSecs: 10, penaltyRateBps: 500 };

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

/** Waits for a ledger that closed after `time`, the RTGS's clock. */
async function closedAfter(session: RtgsSession, time: number): Promise<void> {
  while ((await session.latestLedger()).closeTime <= time) await new Promise((r) => setTimeout(r, 1000));
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

  it("reports a contract id with nothing deployed as a configuration error", async () => {
    await expect(connect(net, { contractId: "CBBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEE5XW" })).rejects.toMatchObject({
      kind: "config",
      title: "No settlement contract",
    });
  });

  it("reuses the deployment when the bootstrap runs again", async () => {
    const again: string[] = [];
    const rerun = await bootstrapDevnet({ network: net, wasm: await readSettlementWasm(), config: CONFIG, banks: 3, onStep: (s) => again.push(`${s.status} ${s.step}`) });
    expect(rerun.contractId).toBe(deployment.contractId);
    expect(again.filter((s) => !s.startsWith("start"))).toEqual(
      ["fund", "issuer-flags", "sac", "banks", "contract", "authorize-contract", "publish"].map((s) => `skipped ${s}`),
    );
  });

  it("refuses mainnet without the app's confirmation", async () => {
    await expect(connect({ ...net, id: "mainnet", passphrase: PASSPHRASES.mainnet })).rejects.toMatchObject({
      kind: "mainnet-not-acknowledged",
    });
  });

  it("probes capabilities: the committed Wasm implements every entry point", () => {
    expect(session.capabilities).toEqual(allAvailable());
  });

  it("lists the banks from the ledger registry, named, without the central bank", async () => {
    const banks = await session.registry.load();
    expect(banks.map((b) => b.address).sort()).toEqual(ids.banks.map((b) => b.address).sort());
    for (const b of banks) {
      expect(b.name).toMatch(/^Bank \d$/);
      expect(b.sources).toEqual(expect.arrayContaining(["ledger", "devnet"]));
    }
  });

  it("registers, renames and unregisters a bank with or without a name", async () => {
    const extra = Keypair.random().publicKey();
    await session.registry.register(ids.centralBank, { address: extra });
    expect(session.registry.get(extra)).toEqual({ address: extra, sources: ["ledger"] });
    await session.registry.register(ids.centralBank, { address: extra, name: "  Extra Bank  " });
    expect(session.registry.get(extra)!.name).toBe("Extra Bank");
    await session.registry.register(ids.centralBank, { address: extra });
    expect(session.registry.get(extra)!.name).toBeUndefined();
    await session.registry.unregister(ids.centralBank, extra);
    expect(session.registry.get(extra)).toBeUndefined();
    const ledger = await session.registry.load();
    expect(ledger.some((b) => b.address === extra)).toBe(false);
  });

  it("spreads a registration, rename and removal to another session on its next load", async () => {
    const other = await connect(net);
    try {
      const extra = Keypair.random().publicKey();
      await session.registry.register(ids.centralBank, { address: extra, name: "Elsewhere" });
      expect((await other.registry.load()).find((b) => b.address === extra)?.name).toBe("Elsewhere");
      await session.registry.register(ids.centralBank, { address: extra });
      expect((await other.registry.load()).find((b) => b.address === extra)?.name).toBeUndefined();
      await session.registry.unregister(ids.centralBank, extra);
      expect((await other.registry.load()).some((b) => b.address === extra)).toBe(false);
    } finally {
      other.dispose();
    }
  });

  it("tells an unfunded account to fund itself, for contract and classic calls alike", async () => {
    const ghost = session.as(keypairSigner(Keypair.random(), net));
    await expect(ghost.deposit(1n)).rejects.toMatchObject({ title: "No such account" });
    await expect(ghost.openTrustline()).rejects.toMatchObject({ title: "No such account" });
    expect(await ghost.simulate.deposit(1n)).toMatchObject({ ok: false, error: { title: "No such account" } });
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

    const withdrawal = await b1.withdraw(parseAmount("100"));
    expect(withdrawal.events.map((e) => e.type)).toEqual(["Withdrawn"]);

    // The feed delivers the same events, with the same ids, in order.
    const all = [...deposit.events, ...atOnce.events, ...normal.events, ...urgent.events, ...release.events, ...withdrawal.events];
    const last = withdrawal.events.at(-1)!;
    await waitFor("the feed to catch up", () => seen.some((e) => e.eventId === last.eventId));
    feed.stop();
    const fromFeed = seen.filter((e) => e.type !== "Token");
    for (const e of all) expect(fromFeed.find((f) => f.eventId === e.eventId)).toEqual(e);
    const types = fromFeed.map((e) => e.type);
    expect(types).toEqual([
      "Deposited", "Submitted", "Settled", "Submitted", "Submitted", "Reprioritised", "Revoked", "Deposited", "Settled", "Withdrawn",
    ]);
    expect(feed.status()).toMatchObject({ clamped: false });

    // The cash token holdings moved with the deposits and the withdrawal.
    expect(await session.token.balance(b1.address)).toBe(parseAmount("9100"));
    expect(await session.token.balance(session.contractId)).toBe(parseAmount("1150"));
  });

  it("keeps a store that converges with the views and explains each settlement", async () => {
    const { store, release } = session.store({ feed: { pollMs: 500 } });
    expect(() => session.store({ recentPayments: 5 })).toThrow(/other options/);
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

  it("lets a keeper reject a queued payment once its expiry has passed (ADR-0015)", async () => {
    const b3 = session.as(ids.banks[2]!);
    const keeper = session.as(ids.banks[0]!);
    const queued = await b3.submit({ to: ids.banks[0]!.address, amount: parseAmount("5000"), priority: "normal" });
    expect(queued.value.disposition).toBe("queued");
    const id = queued.value.id;
    expect(await keeper.simulate.expire(id)).toMatchObject({ ok: false, error: { kind: "contract", code: 9 } });

    const payment = (await session.read.payment(id))!;
    await closedAfter(session, payment.submittedAt + CONFIG.expirySecs);
    const config = await session.read.config();
    const now = (await session.latestLedger()).closeTime;
    const head = (await session.read.bank(ids.banks[2]!.address, { config })).analysis.normal.head!;
    expect(head.id).toBe(id);
    expect(isExpired(head, config, now)).toBe(true);

    const outcome = await keeper.expire(id);
    expect(outcome.events.map((e) => e.type)).toEqual(["Expired"]);
    expect((await session.read.payment(id))?.status).toBe("expired");
    expect(await session.read.queue(ids.banks[2]!.address, "normal")).toEqual([]);
  });

  it("settles crossing payment orders in an offset, which the store explains (A3)", async () => {
    const [b1, b3] = [session.as(ids.banks[0]!), session.as(ids.banks[2]!)];
    const amount = parseAmount("1000");
    const balances = await Promise.all([session.read.balance(b1.address), session.read.balance(b3.address)]);
    // Neither balance covers its payment order alone, but the two net to zero.
    expect(balances.every((b) => b < amount)).toBe(true);
    const { store, release } = session.store({ feed: { pollMs: 500 } });
    try {
      const first = await b3.submit({ to: b1.address, amount, priority: "normal" });
      expect(first.value.disposition).toBe("queued");
      const second = await b1.submit({ to: b3.address, amount, priority: "normal" });
      expect(second.value.disposition).toBe("settled");
      expect(second.events.map((e) => e.type)).toEqual(["Submitted", "Offset", "Settled", "Settled"]);
      expect(second.events[1]).toMatchObject({ type: "Offset", ids: [first.value.id, second.value.id] });
      expect(await Promise.all([session.read.balance(b1.address), session.read.balance(b3.address)])).toEqual(balances);
      expect(await session.read.queuedCount()).toBe(0);
      for (const id of [first.value.id, second.value.id]) {
        const p = await waitFor(`#${id} settled in the store`, () => {
          const p = store.getSnapshot().payments.get(id);
          return p?.status === "settled" ? p : undefined;
        });
        expect(p.steps.at(-1)).toMatchObject({ kind: "settled", via: "offset" });
      }
    } finally {
      release();
    }
  });

  it("runs a repo from collateral to penalty to repayment, as views and events agree (A12-A14, A20)", async () => {
    const cb = session.as(ids.centralBank);
    const bank = session.as(ids.banks[1]!);
    const keeper = session.as(ids.banks[0]!);
    const credit = (intraday: string, penalty: string) => ({ intraday: parseAmount(intraday), penalty: parseAmount(penalty), collateral: parseAmount("50") });

    expect((await cb.setCollateral(bank.address, parseAmount("50"))).events.map((e) => e.type)).toEqual(["CollateralSet"]);
    await expect(cb.openRepo(bank.address, parseAmount("51"))).rejects.toMatchObject({ kind: "contract", code: 12 });
    const before = await session.read.balance(bank.address);
    const held = await session.token.balance(session.contractId);
    const opened = await cb.openRepo(bank.address, parseAmount("30"));
    const repoId = opened.value.repoId;
    expect(opened.events).toMatchObject([{ type: "RepoOpened", id: repoId, bank: bank.address, amount: parseAmount("30") }]);
    // The repo's cash is minted into the contract and credited to the bank's balance (ADR-0011).
    expect(await session.read.balance(bank.address)).toBe(before + parseAmount("30"));
    expect(await session.token.balance(session.contractId)).toBe(held + parseAmount("30"));
    expect(await session.read.credit(bank.address)).toEqual(credit("30", "0"));
    await expect(cb.setCollateral(bank.address, parseAmount("29"))).rejects.toMatchObject({ kind: "contract", code: 11 });

    const partial = await bank.repay(repoId, parseAmount("10"));
    expect(partial.events).toMatchObject([{ type: "RepoRepaid", id: repoId, amount: parseAmount("10"), outstanding: parseAmount("20") }]);
    expect(await session.read.credit(bank.address)).toEqual(credit("20", "0"));

    // Once its term has passed, anyone turns the repo into a penalty repo (ADR-0014).
    expect(await keeper.simulate.convertOverdue(repoId)).toMatchObject({ ok: false, error: { kind: "contract", code: 15 } });
    const repo = (await session.read.repo(repoId))!;
    await closedAfter(session, repo.openedAt + CONFIG.repoTermSecs);
    const penalised = await keeper.convertOverdue(repoId);
    expect(penalised.events).toMatchObject([{ type: "RepoPenalised", id: repoId, rateBps: CONFIG.penaltyRateBps }]);
    expect(await session.read.repo(repoId)).toMatchObject({ status: "penalty", rateBps: CONFIG.penaltyRateBps, outstanding: parseAmount("20") });
    expect(await session.read.credit(bank.address)).toEqual(credit("0", "20"));

    // The central bank repays on the bank's behalf, from the bank's balance, and the cash is burned.
    await cb.repay(repoId, parseAmount("20"));
    expect(await session.read.repo(repoId)).toMatchObject({ status: "repaid", outstanding: 0n });
    expect(await session.read.credit(bank.address)).toEqual(credit("0", "0"));
    expect(await session.read.balance(bank.address)).toBe(before);
    expect(await session.token.balance(session.contractId)).toBe(held);
    await expect(bank.repay(repoId, 1n)).rejects.toMatchObject({ kind: "contract", code: 14 });
  });

  it("decodes the run's raw events as the feed did, and records them as unit fixtures on request", async () => {
    const health = await session.server.getHealth();
    const raw = await session.server._getEvents({
      startLedger: health.oldestLedger,
      filters: [{ type: "contract", contractIds: [session.contractId] }],
      limit: 1000,
    });
    const fixtures = raw.events.map((e) => {
      const body = decodeBody(
        (e.topic ?? []).map((t) => xdr.ScVal.fromXdr(t, "base64")),
        xdr.ScVal.fromXdr(e.value, "base64"),
      );
      return { topic: e.topic ?? [], value: e.value, expected: body };
    });
    const types = new Set(fixtures.map((f) => f.expected.type));
    const expected = ["Deposited", "Withdrawn", "Submitted", "Settled", "Offset", "Reprioritised", "Revoked", "Expired", "CollateralSet", "RepoOpened", "RepoRepaid", "RepoPenalised"];
    for (const t of expected) expect(types.has(t as never)).toBe(true);
    expect(types.has("Unknown")).toBe(false);
    if (process.env.RTGS_RECORD_FIXTURES) {
      const json = JSON.stringify(fixtures, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v), 2);
      writeFileSync(new URL("../test/fixtures/devnet-events.json", import.meta.url), json + "\n");
    }
  });
});
