// The shared read model: a snapshot of the system the apps render, kept current by the event
// feed. It loads the views first (config, every known bank's balance and queues, the newest
// payment orders), then replays events from the retention window and follows new ones. The
// views stay authoritative: after each batch of events, the banks it touched are re-read.
//
// Framework-agnostic: `subscribe` / `getSnapshot` fit React's `useSyncExternalStore`.
import type { Capabilities } from "../capabilities.ts";
import { latestId, mapLimit } from "../contract/gateway.ts";
import { RtgsError, toRtgsError } from "../errors.ts";
import type { EventFeed, FeedOptions, FeedStatus } from "../events/feed.ts";
import type { Bank } from "../registry/banks.ts";
import type { LedgerClock } from "../rpc.ts";
import type { BankView, RtgsSession } from "../session.ts";
import type { Config, FeedEvent, Payment, Repo } from "../types.ts";
import { applyEvents, emptyState, mergePayments, mergeRepos, type ModelState, type PaymentRecord } from "./reducer.ts";

export interface StoreOptions {
  feed?: FeedOptions;
  /** How many of the newest payment orders to read from the views at start. */
  recentPayments?: number;
  /** How many of the newest repos to read, once `repo` is implemented. */
  recentRepos?: number;
  /** How long to gather touched banks before re-reading them. */
  refreshDebounceMs?: number;
  /**
   * How often to re-read the bank registry from the central bank's account, so a bank another
   * app registers shows up (0 turns it off). `session.registry.load()` does it on demand.
   */
  registryPollMs?: number;
}

export interface SystemSnapshot {
  status: "loading" | "ready" | "error";
  /** The last failure (initial load, or a later refresh). */
  error?: RtgsError;
  contractId: string;
  centralBank: string;
  capabilities: Capabilities;
  config?: Config;
  /** Payment orders queued across all banks, against `config.queueCap`. */
  queuedCount: number;
  banks: ReadonlyMap<string, BankView>;
  payments: ReadonlyMap<bigint, PaymentRecord>;
  repos: ReadonlyMap<bigint, Repo>;
  /** Collateral values from `CollateralSet` events. */
  collateral: ReadonlyMap<string, bigint>;
  /** The most recent events, oldest first. */
  events: readonly FeedEvent[];
  registry: readonly Bank[];
  feed: FeedStatus;
  /** The latest ledger the store has seen: the RTGS's clock. */
  ledger?: LedgerClock;
}

function touchedBy(event: FeedEvent, model: ModelState): string[] {
  switch (event.type) {
    case "Deposited":
    case "Withdrawn":
    case "CollateralSet":
    case "RepoOpened":
      return [event.bank];
    case "Submitted":
    case "Settled":
      return [event.from, event.to];
    case "Revoked":
    case "Reprioritised":
    case "Expired": {
      const from = model.payments.get(event.id)?.from;
      return from ? [from] : [];
    }
    case "Token":
      return [event.from, event.to].filter((a): a is string => !!a);
    default:
      return [];
  }
}

export class RtgsStore {
  private model: ModelState = emptyState();
  private banks = new Map<string, BankView>();
  private snapshot: SystemSnapshot;
  private readonly listeners = new Set<() => void>();
  private feed: EventFeed | undefined;
  private unsubscribers: (() => void)[] = [];
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** A store runs once: `start()` after `stop()` throws; make a new one instead. */
  private phase: "new" | "running" | "stopped" = "new";
  /** Payment orders an event mentioned that the store doesn't know in full. */
  private pendingPayments = new Set<bigint>();
  /** Refreshes run one after another, so an older read never overwrites a newer one. */
  private refreshChain: Promise<void> = Promise.resolve();
  private loadAttempts = 0;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private registryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly session: RtgsSession,
    private readonly options: StoreOptions = {},
  ) {
    this.snapshot = {
      status: "loading",
      contractId: session.contractId,
      centralBank: session.centralBank,
      capabilities: session.capabilities,
      queuedCount: 0,
      banks: new Map(),
      payments: new Map(),
      repos: new Map(),
      collateral: new Map(),
      events: [],
      registry: session.registry.list(),
      feed: { state: "idle", clamped: false },
    };
  }

  readonly getSnapshot = (): SystemSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<SystemSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      payments: this.model.payments,
      repos: this.model.repos,
      collateral: this.model.collateral,
      events: this.model.events,
      banks: this.banks,
      registry: this.session.registry.list(),
      ...patch,
    };
    for (const l of this.listeners) l();
  }

  private get running(): boolean {
    return this.phase === "running";
  }

  start(): void {
    if (this.phase === "stopped") {
      throw new RtgsError("config", "Store stopped", "A stopped store can't restart; get a new one from session.store().");
    }
    if (this.phase === "running") return;
    this.phase = "running";
    void this.load();
  }

  stop(): void {
    this.phase = "stopped";
    this.feed?.stop();
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
    if (this.registryTimer) clearInterval(this.registryTimer);
    this.registryTimer = undefined;
    this.pending.clear();
    this.pendingPayments.clear();
  }

  /**
   * The initial load. A failure (an RPC timeout or rate limit) leaves `status: "error"` and
   * tries again with backoff while the store runs; `retry()` tries again at once.
   */
  private async load(): Promise<void> {
    const { read, registry } = this.session;
    this.loadAttempts += 1;
    try {
      const [config, queuedCount, ledger] = await Promise.all([read.config(), read.queuedCount(), this.session.latestLedger()]);
      if (!this.running) return;
      this.update({ config, queuedCount, ledger });
      try {
        await registry.load();
      } catch (e) {
        this.update({ error: toRtgsError(e) });
      }
      await this.loadRecentPayments();
      await this.loadRepos();
      await this.refreshBanks(registry.list().map((b) => b.address));
      if (!this.running) return;
      this.update({ status: "ready", error: undefined });
      this.followEvents();
    } catch (e) {
      if (!this.running) return;
      this.update({ status: "error", error: toRtgsError(e) });
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.loadAttempts - 1, 5));
      this.loadTimer = setTimeout(() => {
        this.loadTimer = undefined;
        void this.load();
      }, delay);
    }
  }

  /** After a failed initial load, tries again now instead of waiting for the next retry. */
  retry(): void {
    if (!this.running || this.snapshot.status !== "error" || !this.loadTimer) return;
    clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
    void this.load();
  }

  /** Re-reads the registry; banks it hasn't seen get their views. */
  private async reloadRegistry(): Promise<void> {
    try {
      await this.session.registry.load();
    } catch {
      // Kept as it was; the next poll tries again.
    }
  }

  private async loadRecentPayments(): Promise<void> {
    const { read } = this.session;
    const latest = await read.latestPaymentId();
    if (latest === undefined) return;
    const count = BigInt(this.options.recentPayments ?? 200);
    const from = latest + 1n > count ? latest + 1n - count : 0n;
    this.model = mergePayments(this.model, await read.payments({ from, to: latest }));
  }

  /** Repos have no list view; with `repo` implemented, ids are probed like payment ids. */
  private async loadRepos(): Promise<void> {
    const { read, capabilities } = this.session;
    if (capabilities.repo !== "available") return;
    const last = await latestId(async (id) => (await read.repo(id)) !== undefined);
    if (last === undefined) return;
    const count = BigInt(this.options.recentRepos ?? 200);
    const from = last + 1n > count ? last + 1n - count : 0n;
    const ids = Array.from({ length: Number(last - from) + 1 }, (_, i) => from + BigInt(i));
    const repos = (await mapLimit(ids, 8, (id) => read.repo(id))).filter((r): r is Repo => !!r);
    this.model = mergeRepos(this.model, repos);
  }

  private followEvents(): void {
    const feed = this.session.events({ from: "retention-start", includeToken: true, ...this.options.feed });
    this.feed = feed;
    this.unsubscribers.push(
      feed.subscribe((batch) => this.onEvents(batch)),
      feed.onStatus((status) => {
        const patch: Partial<SystemSnapshot> = { feed: status };
        if (status.latestLedger !== undefined && status.latestLedgerCloseTime !== undefined) {
          // A new object only for a new ledger, so the ledger clock doesn't restart every poll.
          const seen = this.snapshot.ledger?.sequence ?? 0;
          if (status.latestLedger > seen) patch.ledger = { sequence: status.latestLedger, closeTime: status.latestLedgerCloseTime };
        }
        this.update(patch);
      }),
      this.session.registry.subscribe((banks) => {
        // A bank new to the registry (registered here, read from the ledger, or seen in an
        // event) gets its views.
        for (const b of banks) if (!this.banks.has(b.address)) this.pending.add(b.address);
        this.update({});
        this.scheduleRefresh();
      }),
    );
    const every = this.options.registryPollMs ?? 30_000;
    if (every > 0) this.registryTimer = setInterval(() => void this.reloadRegistry(), every);
    feed.start();
  }

  private onEvents(batch: FeedEvent[]): void {
    if (!this.running) return;
    this.model = applyEvents(this.model, batch);
    const added = this.session.registry.observe(this.model.seen);
    for (const e of batch) {
      for (const a of touchedBy(e, this.model)) this.pending.add(a);
      // An event about a payment order older than what the store loaded: read it in full.
      if (e.type === "Settled" || e.type === "Revoked" || e.type === "Expired" || e.type === "Reprioritised") {
        const known = this.model.payments.get(e.id);
        if (!known || known.partial) this.pendingPayments.add(e.id);
      }
    }
    for (const a of added) this.pending.add(a);
    this.update({});
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.timer || (!this.pending.size && !this.pendingPayments.size)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const banks = [...this.pending];
      const payments = [...this.pendingPayments];
      this.pending.clear();
      this.pendingPayments.clear();
      void this.enqueue(banks, payments);
    }, this.options.refreshDebounceMs ?? 250);
  }

  private enqueue(banks: string[] | undefined, payments: bigint[] = []): Promise<void> {
    this.refreshChain = this.refreshChain.then(() => this.runRefresh(banks, payments));
    return this.refreshChain;
  }

  /** Re-reads the given banks (default: all known) and the queued count from the views. */
  refresh(banks?: string[]): Promise<void> {
    return this.enqueue(banks);
  }

  private async runRefresh(banks: string[] | undefined, payments: bigint[]): Promise<void> {
    if (!this.running) return;
    try {
      const queuedCount = await this.session.read.queuedCount();
      if (payments.length) {
        const found = await mapLimit(payments, 8, (id) => this.session.read.payment(id));
        if (!this.running) return;
        this.model = mergePayments(this.model, found.filter((p): p is Payment => !!p));
      }
      await this.refreshBanks(banks ?? this.session.registry.list().map((b) => b.address));
      if (this.running) this.update({ queuedCount, error: undefined });
    } catch (e) {
      if (this.running) this.update({ error: toRtgsError(e) });
    }
  }

  private async refreshBanks(addresses: string[]): Promise<void> {
    const known = new Set(this.session.registry.list().map((b) => b.address));
    const targets = addresses.filter((a) => known.has(a));
    const config = this.snapshot.config;
    const views = await mapLimit(targets, 4, (address) => this.session.read.bank(address, config ? { config } : {}));
    if (!this.running) return;
    const banks = new Map(this.banks);
    for (const view of views) {
      const name = this.session.registry.get(view.address)?.name;
      banks.set(view.address, name ? { ...view, name } : view);
      this.model = mergePayments(this.model, [...view.queues.urgent, ...view.queues.normal]);
    }
    this.banks = banks;
    this.update({});
  }
}
