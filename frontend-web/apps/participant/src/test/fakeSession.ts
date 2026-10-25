// An in-memory stand-in for a core session and its store, for component tests. It follows the
// contract's rules closely enough for the UI: strict FIFO per priority, urgent before normal,
// settlement at once when nothing is queued ahead and the balance covers it, and an eager
// closure after every balance increase, revocation or reprioritisation.
import {
  allAvailable,
  analyseQueues,
  covers,
  devnetIdentities,
  loadNetworks,
  RtgsError,
  toRtgsError,
  type Bank,
  type BankView,
  type Capabilities,
  type Config,
  type FeedEvent,
  type Holding,
  type NetworkConfig,
  type PaymentRecord,
  type Priority,
  type Repo,
  type RtgsEvent,
  type RtgsEventBody,
  type RtgsSession,
  type Signer,
  type SystemSnapshot,
  type TxOutcome,
} from "@rtgs/core";

export const CONFIG: Config = { queueCap: 16, expirySecs: 86_400, repoTermSecs: 86_400, penaltyRateBps: 500 };
export const USD = (n: number) => BigInt(Math.round(n * 1e7));

export interface FakeOptions {
  network?: NetworkConfig;
  capabilities?: Partial<Capabilities>;
  /** The store's first load failed with this error. */
  storeError?: { title: string; detail: string };
  /** Settlement balances per bank index (1-based), in stroops. */
  balances?: Record<number, bigint>;
  repos?: Repo[];
}

export function devnet(): NetworkConfig {
  return loadNetworks({})[0]!;
}

export function createFakeSession(options: FakeOptions = {}) {
  const network = options.network ?? devnet();
  const ids = network.id === "devnet" ? devnetIdentities(network, 3) : undefined;
  const banks: Signer[] = ids?.banks ?? [];
  const centralBank = ids?.centralBank.address ?? "GCENTRALBANK";
  const capabilities: Capabilities = { ...allAvailable(), ...options.capabilities };

  let ledger = 1000;
  let closeTime = 1_800_000_000;
  let eventSeq = 0;
  let nextId = 0n;
  const balances = new Map<string, bigint>();
  const holdings = new Map<string, Holding>();
  const queues = new Map<string, bigint[]>();
  const payments = new Map<bigint, PaymentRecord>();
  const repos = new Map<bigint, Repo>((options.repos ?? []).map((r) => [r.id, r]));
  banks.forEach((b, i) => {
    balances.set(b.address, options.balances?.[i + 1] ?? 0n);
    holdings.set(b.address, { balance: USD(10_000), exists: true, authorized: true, authorizedToMaintainLiabilities: false, clawbackEnabled: true });
  });

  const registryBanks: Bank[] = banks.map((b) => ({ address: b.address, name: b.label!, sources: ["ledger", "devnet"] }));
  const registry = {
    list: () => registryBanks,
    get: (a: string) => registryBanks.find((b) => b.address === a),
    nameOf: (a: string) => (a === centralBank ? "Central bank" : (registryBanks.find((b) => b.address === a)?.name ?? `${a.slice(0, 4)}…${a.slice(-4)}`)),
    subscribe: () => () => {},
  };

  const listeners = new Set<() => void>();
  let snapshot: SystemSnapshot = {
    status: "ready",
    contractId: "CCONTRACT",
    centralBank,
    capabilities,
    config: CONFIG,
    queuedCount: 0,
    banks: new Map(),
    payments: new Map(),
    repos: new Map(repos),
    collateral: new Map(),
    events: [],
    registry: registryBanks,
    feed: { state: "live", clamped: false, startLedger: 1 },
    ledger: { sequence: ledger, closeTime },
  };
  // Like core's store, it keeps a view of every registered bank, re-read after each change.
  const views = () => new Map(registryBanks.map((b) => [b.address, viewOf(b.address, CONFIG)]));
  const publish = (events: FeedEvent[]) => {
    snapshot = {
      ...snapshot,
      banks: views(),
      payments: new Map(payments),
      repos: new Map(repos),
      events: [...snapshot.events, ...events],
      ledger: { sequence: ledger, closeTime },
    };
    for (const l of listeners) l();
  };
  const store = {
    refresh: async () => publish([]),
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };

  const qkey = (bank: string, p: Priority) => `${bank}:${p}`;
  const queue = (bank: string, p: Priority) => queues.get(qkey(bank, p)) ?? [];
  const balance = (bank: string) => balances.get(bank) ?? 0n;

  /** Runs one "transaction": closes a ledger and publishes its events. */
  function tx<T>(work: (emit: (e: RtgsEventBody) => void) => T): TxOutcome<T> {
    ledger += 1;
    closeTime += 5;
    const txHash = `tx${ledger}`;
    const events: RtgsEvent[] = [];
    const emit = (body: RtgsEventBody) => {
      eventSeq += 1;
      events.push({
        ...body,
        eventId: `${String(ledger).padStart(19, "0")}-${String(eventSeq).padStart(10, "0")}`,
        ledger,
        closedAt: closeTime,
        txHash,
        contractId: "CCONTRACT",
      } as RtgsEvent);
    };
    const value = work(emit);
    publish(events);
    return { txHash, ledger, closedAt: closeTime, value, events };
  }

  function settle(p: PaymentRecord, emit: (e: RtgsEventBody) => void, via: "at-once" | "eager-closure") {
    balances.set(p.from, balance(p.from) - p.amount);
    balances.set(p.to, balance(p.to) + p.amount);
    const step = { kind: "settled" as const, eventId: `settle-${p.id}`, ledger, closedAt: closeTime, txHash: `tx${ledger}`, via };
    payments.set(p.id, { ...p, status: "settled", settledAt: closeTime, steps: [...p.steps, step] });
    emit({ type: "Settled", id: p.id, from: p.from, to: p.to, amount: p.amount });
  }

  function closure(start: string[], emit: (e: RtgsEventBody) => void) {
    const work = [...start];
    while (work.length) {
      const bank = work.shift()!;
      for (const priority of ["urgent", "normal"] as const) {
        const q = queue(bank, priority);
        while (q.length && covers(balance(bank), payments.get(q[0]!)!.amount)) {
          const p = payments.get(q.shift()!)!;
          settle(p, emit, "eager-closure");
          if (!work.includes(p.to)) work.push(p.to);
        }
        queues.set(qkey(bank, priority), q);
        if (q.length) break;
      }
    }
  }

  const fail = (code: number) => {
    throw toRtgsError(`HostError: Error(Contract, #${code})`);
  };

  function actorFor(signer: Signer) {
    const me = signer.address;
    return {
      address: me,
      signer,
      async deposit(amount: bigint) {
        return tx((emit) => {
          balances.set(me, balance(me) + amount);
          const h = holdings.get(me)!;
          holdings.set(me, { ...h, balance: h.balance - amount });
          emit({ type: "Deposited", bank: me, amount });
          closure([me], emit);
        });
      },
      async withdraw(amount: bigint) {
        if (amount > balance(me)) fail(3);
        return tx((emit) => {
          balances.set(me, balance(me) - amount);
          const h = holdings.get(me)!;
          holdings.set(me, { ...h, balance: h.balance + amount });
          emit({ type: "Withdrawn", bank: me, amount });
        });
      },
      async submit(order: { to: string; amount: bigint; priority: Priority }) {
        if (order.to === me) fail(4);
        const ahead = queue(me, "urgent").length > 0 || (order.priority === "normal" && queue(me, "normal").length > 0);
        const settles = !ahead && covers(balance(me), order.amount);
        return tx((emit) => {
          const id = nextId++;
          const p: PaymentRecord = { id, from: me, to: order.to, amount: order.amount, priority: order.priority, submittedAt: closeTime, status: "queued", steps: [] };
          payments.set(id, p);
          emit({ type: "Submitted", id, from: me, to: order.to, amount: order.amount, priority: order.priority });
          if (settles) {
            settle(p, emit, "at-once");
            closure([order.to], emit);
          } else {
            queues.set(qkey(me, order.priority), [...queue(me, order.priority), id]);
          }
          return { id, disposition: settles ? ("settled" as const) : ("queued" as const) };
        });
      },
      async revoke(id: bigint) {
        const p = payments.get(id);
        if (!p) fail(6);
        if (p!.status !== "queued") fail(7);
        return tx((emit) => {
          queues.set(qkey(me, p!.priority), queue(me, p!.priority).filter((x) => x !== id));
          payments.set(id, { ...p!, status: "revoked" });
          emit({ type: "Revoked", id });
          closure([me], emit);
        });
      },
      async reprioritise(id: bigint, priority: Priority) {
        const p = payments.get(id)!;
        if (p.status !== "queued") fail(7);
        if (p.priority === priority) fail(8);
        return tx((emit) => {
          queues.set(qkey(me, p.priority), queue(me, p.priority).filter((x) => x !== id));
          queues.set(qkey(me, priority), [...queue(me, priority), id].sort((a, b) => (a < b ? -1 : 1)));
          payments.set(id, { ...p, priority });
          emit({ type: "Reprioritised", id, priority });
          closure([me], emit);
        });
      },
      async repay(repoId: bigint, amount: bigint) {
        const r = repos.get(repoId);
        if (!r) fail(13);
        if (amount > r!.outstanding) fail(14);
        return tx((emit) => {
          const outstanding = r!.outstanding - amount;
          repos.set(repoId, { ...r!, outstanding, status: outstanding === 0n ? "repaid" : r!.status });
          balances.set(me, balance(me) - amount);
          emit({ type: "RepoRepaid", id: repoId, amount, outstanding });
        });
      },
      async openTrustline() {
        return tx(() => {
          holdings.set(me, { balance: 0n, exists: true, authorized: false, authorizedToMaintainLiabilities: false, clawbackEnabled: true });
        });
      },
    };
  }

  function viewOf(address: string, config?: Config): BankView {
    const qs = {
      urgent: queue(address, "urgent").map((id) => payments.get(id)!),
      normal: queue(address, "normal").map((id) => payments.get(id)!),
    };
    const view: BankView = { address, balance: balance(address), queues: qs, analysis: analyseQueues(balance(address), qs, config) };
    if (capabilities.credit !== "stub") view.credit = { intraday: 0n, penalty: 0n, collateral: USD(1000) };
    return view;
  }

  const read = {
    async bank(address: string, opts: { config?: Config } = {}): Promise<BankView> {
      return viewOf(address, opts.config);
    },
    async payments(range: { from: bigint; to: bigint }) {
      return [...payments.values()].filter((p) => p.id >= range.from && p.id <= range.to).map(({ steps: _, ...p }) => p);
    },
    async queue(address: string, priority: Priority) {
      return queue(address, priority);
    },
  };

  // Like core's session: closed for good on dispose, and only signers for its own network.
  let disposed = false;
  const assertLive = () => {
    if (disposed) throw new RtgsError("config", "Session closed", "This session was disposed; connect again.");
  };

  const session = {
    network,
    contractId: "CCONTRACT",
    centralBank,
    cashToken: { code: "USD", sacId: "CSAC", issuer: centralBank },
    capabilities,
    registry,
    read,
    token: { holding: async (a: string) => holdings.get(a) ?? { balance: 0n, exists: false, authorized: false, authorizedToMaintainLiabilities: false, clawbackEnabled: false } },
    as: (signer: Signer) => {
      assertLive();
      if (signer.networkPassphrase !== network.passphrase) {
        throw new RtgsError("network-mismatch", "Signer is for another network", `${signer.address} signs for another network.`);
      }
      return actorFor(signer);
    },
    store: () => {
      assertLive();
      return { store, release: () => {} };
    },
    dispose: () => {
      disposed = true;
    },
  };

  snapshot = { ...snapshot, banks: views() };
  if (options.storeError) {
    snapshot = { ...snapshot, status: "error", error: new RtgsError("rpc", options.storeError.title, options.storeError.detail) };
  }

  return {
    session: session as unknown as RtgsSession,
    /** Pretends the store holds only these payment orders, as after a long history. */
    keepOnly(ids: bigint[]) {
      snapshot = { ...snapshot, payments: new Map([...snapshot.payments].filter(([k]) => ids.includes(k))) };
      for (const l of listeners) l();
    },
    banks,
    disposed: () => disposed,
    /** Acts as bank `n` (1-based) directly, e.g. another bank paying the one under test. */
    as: (n: number) => actorFor(banks[n - 1]!),
    balance,
    /** Advances the ledger clock without a transaction. */
    tick(secs: number) {
      closeTime += secs;
      ledger += 1;
      publish([]);
    },
  };
}
