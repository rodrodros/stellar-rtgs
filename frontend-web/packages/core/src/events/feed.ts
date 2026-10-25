// The event feed: RPC `getEvents` on the settlement contract (and, optionally, the cash token's
// SAC), paged with a cursor, polled, deduplicated and decoded into typed events.
//
// RPC keeps events only within its retention window (about 7 days by default, 120,960 ledgers;
// handbook 06 §8). A start before the window is clamped to its oldest ledger and the status
// says so; older history needs an indexer, which this project does not have. Payment orders
// themselves stay readable through the contract's views.
import { rpc } from "@stellar/stellar-sdk";
import { notifyAll, RtgsError, toRtgsError } from "../errors.ts";
import type { RpcServer } from "../rpc.ts";
import type { FeedEvent } from "../types.ts";
import { decodeFeedEvent } from "./decode.ts";

export type FeedStart = { ledger: number } | { cursor: string } | "retention-start" | "now";

export interface FeedOptions {
  /** Where to start; the oldest retained ledger by default. */
  from?: FeedStart;
  /** Also follow the cash token's SAC (transfers, mints, clawbacks, authorizations). */
  includeToken?: boolean;
  /** How often to poll once caught up. */
  pollMs?: number;
  /** Events per request (RPC allows up to 10,000). */
  pageLimit?: number;
}

export interface FeedStatus {
  /** `backfilling` until the feed has read up to the latest ledger, then `live`. */
  state: "idle" | "backfilling" | "live" | "error";
  /** Resume from here to continue without gaps. */
  cursor?: string;
  /** The ledger the cursor has read up to. */
  cursorLedger?: number;
  /** The ledger the feed started from, after clamping to the retention window. */
  startLedger?: number;
  /** True if the requested start (or a saved cursor) was older than the retention window. */
  clamped: boolean;
  latestLedger?: number;
  latestLedgerCloseTime?: number;
  /** The oldest ledger RPC still serves: nothing older can be replayed. */
  oldestLedger?: number;
  oldestLedgerCloseTime?: number;
  /** How many ledgers RPC keeps (its retention window). */
  retentionWindow?: number;
  error?: RtgsError;
}

export interface FeedSource {
  server: RpcServer;
  contractId: string;
  sacId?: string;
}

const MAX_BACKOFF_MS = 30_000;

/** The ledger a `getEvents` cursor points into: the high 32 bits of its TOID. */
export function cursorLedger(cursor: string): number | undefined {
  const toid = cursor.split("-")[0];
  if (!toid || !/^\d+$/.test(toid)) return undefined;
  return Number(BigInt(toid) >> 32n);
}

/** RPC's refusal of a start or cursor outside its retention window. */
function outsideRetention(error: RtgsError): boolean {
  return /ledger range|retention|cursor/i.test(error.detail);
}

export class EventFeed {
  private readonly listeners = new Set<(batch: FeedEvent[]) => void>();
  private readonly statusListeners = new Set<(status: FeedStatus) => void>();
  private current: FeedStatus = { state: "idle", clamped: false };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** Bumped by every start and stop, so a tick from an earlier run can't schedule another. */
  private generation = 0;
  private lastId = "";
  private failures = 0;
  /** Set when the feed restarted from the retention window, until a request succeeds again. */
  private resetSinceSuccess = false;
  private from: FeedStart;

  constructor(
    private readonly source: FeedSource,
    private readonly options: FeedOptions = {},
    /** Lets an owner (the session) track running feeds, to stop them on dispose. */
    private readonly hooks: { onStart?: (feed: EventFeed) => void; onStop?: (feed: EventFeed) => void } = {},
  ) {
    this.from = options.from ?? "retention-start";
  }

  /** Receives each batch of new events, in order. */
  subscribe(listener: (batch: FeedEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: FeedStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  status(): FeedStatus {
    return this.current;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.failures = 0;
    this.resetSinceSuccess = false;
    this.hooks.onStart?.(this);
    void this.tick(this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.setStatus({ state: "idle" });
    this.hooks.onStop?.(this);
  }

  private setStatus(patch: Partial<FeedStatus>): void {
    this.current = { ...this.current, ...patch };
    if (patch.state !== "error" && this.current.error) delete this.current.error;
    notifyAll(this.statusListeners, this.current);
  }

  private schedule(generation: number, ms: number): void {
    if (generation !== this.generation) return;
    this.timer = setTimeout(() => void this.tick(generation), ms);
  }

  private filters(): rpc.Api.EventFilter[] {
    const ids = [this.source.contractId];
    if (this.options.includeToken && this.source.sacId) ids.push(this.source.sacId);
    return [{ type: "contract", contractIds: ids }];
  }

  /** The first request: a start ledger within the retention window, or a saved cursor. */
  private async firstRequest(limit: number): Promise<rpc.Api.GetEventsRequest> {
    const health = await this.source.server.getHealth();
    this.setStatus({
      oldestLedger: health.oldestLedger,
      latestLedger: health.latestLedger,
      retentionWindow: health.ledgerRetentionWindow,
    });
    const from = this.from;
    if (typeof from === "object" && "cursor" in from) return { filters: this.filters(), cursor: from.cursor, limit };
    let startLedger = health.oldestLedger;
    let clamped = this.current.clamped;
    if (from === "now") startLedger = health.latestLedger;
    else if (typeof from === "object") {
      clamped = clamped || from.ledger < health.oldestLedger;
      startLedger = Math.min(Math.max(from.ledger, health.oldestLedger), health.latestLedger);
    }
    this.setStatus({ startLedger, clamped });
    return { filters: this.filters(), startLedger, limit };
  }

  private async tick(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const limit = this.options.pageLimit ?? 1000;
    try {
      const request: rpc.Api.GetEventsRequest = this.current.cursor
        ? { filters: this.filters(), cursor: this.current.cursor, limit }
        : await this.firstRequest(limit);
      const response = await this.source.server.getEvents(request);
      if (generation !== this.generation) return;
      const batch = response.events.filter((e) => e.id > this.lastId).map((e) => this.decode(e));
      const last = batch.at(-1);
      if (last) this.lastId = last.eventId;
      this.failures = 0;
      this.resetSinceSuccess = false;
      // RPC scans a bounded range of ledgers per request, so a short page doesn't mean caught
      // up: the cursor's ledger does.
      const reached = cursorLedger(response.cursor);
      const behind = response.events.length >= limit || (reached !== undefined && reached < response.latestLedger);
      this.setStatus({
        state: behind ? "backfilling" : "live",
        cursor: response.cursor,
        ...(reached === undefined ? {} : { cursorLedger: reached }),
        latestLedger: response.latestLedger,
        latestLedgerCloseTime: Number(response.latestLedgerCloseTime),
        oldestLedger: response.oldestLedger,
        oldestLedgerCloseTime: Number(response.oldestLedgerCloseTime),
      });
      if (batch.length) this.deliver(batch);
      this.schedule(generation, behind ? 0 : (this.options.pollMs ?? 2000));
    } catch (e) {
      if (generation !== this.generation) return;
      const error = toRtgsError(e);
      this.failures += 1;
      // A start or cursor that fell out of the retention window: restart from its oldest
      // ledger at once, whatever failed before. Only once until a request succeeds, so a
      // persistent error can't make it loop without backoff.
      const resumable = this.current.cursor !== undefined || typeof this.from === "object";
      if (outsideRetention(error) && resumable && !this.resetSinceSuccess) {
        this.resetSinceSuccess = true;
        this.from = "retention-start";
        this.setStatus({ state: "backfilling", clamped: true, cursor: undefined, cursorLedger: undefined });
        this.schedule(generation, 0);
        return;
      }
      this.setStatus({ state: "error", error });
      this.schedule(generation, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures, 5)));
    }
  }
  /**
   * Gives the batch to every listener. A listener that throws doesn't stop the others or the
   * feed; its error is reported on its own.
   */
  private deliver(batch: FeedEvent[]): void {
    notifyAll(this.listeners, batch);
  }

  private decode(e: rpc.Api.EventResponse): FeedEvent {
    return decodeFeedEvent(
      {
        eventId: e.id,
        ledger: e.ledger,
        closedAt: Math.floor(Date.parse(e.ledgerClosedAt) / 1000),
        txHash: e.txHash,
        contractId: e.contractId?.contractId() ?? "",
      },
      e.topic,
      e.value,
      this.source.contractId,
    );
  }
}
