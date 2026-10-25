// The shared read model: a snapshot of the system the apps render, kept current by the event
// feed. It loads the views first (config, every known bank's balance and queues, the newest
// payment orders), then replays events from the retention window and follows new ones. The
// views stay authoritative: after each batch of events, the banks it touched are re-read.
//
// Framework-agnostic: `subscribe` / `getSnapshot` fit React's `useSyncExternalStore`.
import type { Capabilities } from "../capabilities.ts";
import { latestId, mapLimit } from "../contract/gateway.ts";
import { toRtgsError, type RtgsError } from "../errors.ts";
import type { EventFeed, FeedOptions, FeedStatus } from "../events/feed.ts";
import type { Bank } from "../registry/banks.ts";
import type { LedgerClock } from "../rpc.ts";
import type { BankView, RtgsSession } from "../session.ts";
import type { Config, FeedEvent, Repo } from "../types.ts";
import { applyEvents, emptyState, mergePayments, mergeRepos, type ModelState, type PaymentRecord } from "./reducer.ts";

export interface StoreOptions {
  feed?: FeedOptions;
  /** How many of the newest payment orders to read from the views at start. */
  recentPayments?: number;
  /** How long to gather touched banks before re-reading them. */
  refreshDebounceMs?: number;
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
  private running = false;

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

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.load();
  }

  stop(): void {
    this.running = false;
    this.feed?.stop();
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    if (this.timer) clearTimeout(this.timer);
  }

  private async load(): Promise<void> {
    const { read, registry } = this.session;
    try {
      const [config, queuedCount, ledger] = await Promise.all([read.config(), read.queuedCount(), this.session.latestLedger()]);
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
      this.update({ status: "ready" });
      this.followEvents();
    } catch (e) {
      this.update({ status: "error", error: toRtgsError(e) });
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
    const ids = Array.from({ length: Number(last) + 1 }, (_, i) => BigInt(i));
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
          const seen = this.snapshot.ledger?.sequence ?? 0;
          if (status.latestLedger >= seen) patch.ledger = { sequence: status.latestLedger, closeTime: status.latestLedgerCloseTime };
        }
        this.update(patch);
      }),
      this.session.registry.subscribe(() => this.update({})),
    );
    feed.start();
  }

  private onEvents(batch: FeedEvent[]): void {
    this.model = applyEvents(this.model, batch);
    const added = this.session.registry.observe(this.model.seen);
    for (const e of batch) for (const a of touchedBy(e, this.model)) this.pending.add(a);
    for (const a of added) this.pending.add(a);
    this.update({});
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const banks = [...this.pending];
      this.pending.clear();
      void this.refresh(banks);
    }, this.options.refreshDebounceMs ?? 250);
  }

  /** Re-reads the given banks (default: all known) and the queued count from the views. */
  async refresh(banks?: string[]): Promise<void> {
    try {
      const queuedCount = await this.session.read.queuedCount();
      await this.refreshBanks(banks ?? this.session.registry.list().map((b) => b.address));
      this.update({ queuedCount });
    } catch (e) {
      this.update({ error: toRtgsError(e) });
    }
  }

  private async refreshBanks(addresses: string[]): Promise<void> {
    const known = new Set(this.session.registry.list().map((b) => b.address));
    const targets = addresses.filter((a) => known.has(a));
    const views = await mapLimit(targets, 4, (address) =>
      this.session.read.bank(address, {
        ...(this.snapshot.config ? { config: this.snapshot.config } : {}),
        ...(this.snapshot.ledger ? { now: this.snapshot.ledger.closeTime } : {}),
      }),
    );
    if (!this.running && this.snapshot.status !== "loading") return;
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
