// The central bank's work end to end against a running devnet (stellar-implementation's
// `make devnet-up`), through the same core calls and app logic the UI uses:
//   make -C ../stellar-implementation devnet-up        # http://localhost:8300/rpc
//   pnpm --filter @rtgs/central-bank test:e2e
// For a devnet of your own, pass IMPL_NAME and IMPL_PORT to make, and RTGS_DEVNET_RPC here.
// Each run uses a fresh seed, so it bootstraps its own central bank, banks and contract.
import {
  bootstrapDevnet,
  connect,
  expirablePayments,
  devnetIdentities,
  loadNetworks,
  parseAmount,
  withOverrides,
  type DevnetIdentities,
  type NetworkConfig,
  type RtgsSession,
  type RtgsStore,
} from "@rtgs/core";
import { readSettlementWasm } from "@rtgs/core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AutoKeeper } from "../src/keeper/autoKeeper.ts";
import { conservation } from "../src/model/conservation.ts";
import { roleOf } from "../src/session/role.ts";

const RPC = process.env.RTGS_DEVNET_RPC ?? "http://localhost:8300/rpc";
/** lib.sh's config with a 10-second expiry, so the keeper can reject a payment in the test. */
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

async function waitFor<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!up)("the central bank on the devnet", () => {
  const net: NetworkConfig = { ...withOverrides(loadNetworks({})[0]!, { rpcUrl: RPC }), devnetSeed: `e2e-cb-${Date.now()}` };
  let ids: DevnetIdentities;
  let session: RtgsSession;
  let store: RtgsStore;
  let release: () => void;
  let queuedId: bigint;

  beforeAll(async () => {
    await bootstrapDevnet({ network: net, wasm: await readSettlementWasm(), config: CONFIG, banks: 2 });
    ids = devnetIdentities(net, 2);
    session = await connect(net);
    ({ store, release } = session.store({ feed: { pollMs: 500 } }));
  });

  afterAll(() => {
    release?.();
    session?.dispose();
  });

  it("knows the central bank's role, and refuses it to a bank", () => {
    const cb = roleOf(session, ids.centralBank);
    expect(cb.isCentralBank).toBe(true);
    expect(cb.tokenAdmin).toBeDefined();
    const bank = roleOf(session, ids.banks[0]!);
    expect(bank.isCentralBank).toBe(false);
    expect(bank.centralBank).toBeUndefined();
    expect(bank.tokenAdmin).toBeUndefined();
  });

  it("deauthorizes a bank's trustline and authorizes it again", async () => {
    const admin = roleOf(session, ids.centralBank).tokenAdmin!;
    const bank = ids.banks[0]!.address;
    await admin.authorize(bank, false);
    expect((await session.token.holding(bank)).authorized).toBe(false);
    await admin.authorize(bank, true);
    expect((await session.token.holding(bank)).authorized).toBe(true);
  });

  it("issues cash and claws it back from a bank's holding, never from the contract", async () => {
    const admin = roleOf(session, ids.centralBank).tokenAdmin!;
    const bank = ids.banks[1]!.address;
    const before = await session.token.balance(bank);
    await admin.issue(bank, parseAmount("5"));
    expect(await session.token.balance(bank)).toBe(before + parseAmount("5"));
    await admin.clawback(bank, parseAmount("2"));
    expect(await session.token.balance(bank)).toBe(before + parseAmount("3"));
    await expect(admin.clawback(session.contractId, 1n)).rejects.toMatchObject({ title: "Clawback refused" });
  });

  it("sees a bank's deposit and queued payment, and conservation holds", async () => {
    const [a, b] = ids.banks;
    const bankA = session.as(a!);
    await bankA.deposit(parseAmount("100"));
    const submitted = await bankA.submit({ to: b!.address, amount: parseAmount("1000"), priority: "normal" });
    expect(submitted.value.disposition).toBe("queued");
    queuedId = submitted.value.id;

    const view = await waitFor("the queued payment in the store", () => {
      const v = store.getSnapshot().banks.get(a!.address);
      return v?.queues.normal.some((p) => p.id === queuedId) ? v : undefined;
    });
    expect(view.analysis.normal.blockedBy).toBe("uncovered");

    const s = store.getSnapshot();
    const held = (await session.token.holding(session.contractId)).balance;
    const others = await Promise.all([session.read.balance(session.centralBank), session.read.balance(session.contractId)]);
    expect(conservation(held, [...[...s.banks.values()].map((v) => v.balance), ...others]).holds).toBe(true);
  });

  it("freezes the settlement contract and unfreezes it (hazard H1)", async () => {
    const admin = roleOf(session, ids.centralBank).tokenAdmin!;
    const bankA = session.as(ids.banks[0]!);
    await admin.authorize(session.contractId, false);
    try {
      expect((await session.token.holding(session.contractId)).authorized).toBe(false);
      await expect(bankA.deposit(parseAmount("1"))).rejects.toMatchObject({ kind: "contract", code: 2 });
    } finally {
      await admin.authorize(session.contractId, true);
    }
    await bankA.deposit(parseAmount("1"));
  });

  it("opens credit when the contract implements it, and reports it unavailable otherwise", async () => {
    const caps = session.capabilities;
    for (const ep of ["setCollateral", "openRepo", "repay", "convertOverdue", "credit", "repo"] as const) {
      expect(["available", "stub"]).toContain(caps[ep]);
    }
    if (caps.setCollateral !== "available" || caps.openRepo !== "available") return;
    const cb = roleOf(session, ids.centralBank).centralBank!;
    const bank = ids.banks[1]!.address;
    await cb.setCollateral(bank, parseAmount("50"));
    const { value } = await cb.openRepo(bank, parseAmount("20"));
    await waitFor("the repo in the store", () => store.getSnapshot().repos.get(value.repoId));
  });

  it("lets the auto-keeper expire the payment once its expiry has passed", async () => {
    expect(session.capabilities.expire).toBe("available");
    const actor = session.as(ids.centralBank);
    const keeper = new AutoKeeper({
      due: () => {
        const s = store.getSnapshot();
        return { payments: expirablePayments(s.payments.values(), s.config!, s.ledger!.closeTime).map((p) => p.id), repos: [] };
      },
      expire: (id) => actor.expire(id),
      convertOverdue: (id) => actor.convertOverdue(id),
    });
    await waitFor("the payment to be due", () => {
      const s = store.getSnapshot();
      return s.config && s.ledger && expirablePayments(s.payments.values(), s.config, s.ledger.closeTime).some((p) => p.id === queuedId);
    });
    keeper.start();
    await keeper.tick();
    keeper.stop();
    expect((await session.read.payment(queuedId))?.status).toBe("expired");
    await waitFor("the store to see the expiry", () => store.getSnapshot().payments.get(queuedId)?.status === "expired");
  });
});
