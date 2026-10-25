// The event feed: RPC `getEvents` on the settlement contract (and, optionally, the cash token's
// SAC), paged with a cursor, polled, deduplicated and decoded into typed events.
//
// RPC keeps events only within its retention window (about 7 days by default, 120,960 ledgers;
// handbook 06 §8). A start before the window is clamped to its oldest ledger and the status
// says so; older history needs an indexer, which this project does not have. Payment orders
// themselves stay readable through the contract's views.
import { rpc } from "@stellar/stellar-sdk";
import { RtgsError, toRtgsError } from "../errors.ts";
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
  state: "idle" | "backfilling" | "live" | "error";
  /** Resume from here to continue without gaps. */
  cursor?: string;
  /** The ledger the feed started from, after clamping to the retention window. */
  startLedger?: number;
  /** True if the requested start was older than the retention window. */
  clamped: boolean;
  latestLedger?: number;
  latestLedgerCloseTime?: number;
  /** The oldest ledger RPC still serves: nothing older can be replayed. */
  oldestLedger?: number;
  oldestLedgerCloseTime?: number;
  error?: RtgsError;
}

export interface FeedSource {
  server: RpcServer;
  contractId: string;
  sacId?: string;
}

const MAX_BACKOFF_MS = 30_000;

export class EventFeed {
  private readonly listeners = new Set<(batch: FeedEvent[]) => void>();
  private readonly statusListeners = new Set<(status: FeedStatus) => void>();
  private current: FeedStatus = { state: "idle", clamped: false };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastId = "";
  private failures = 0;

  constructor(
    private readonly source: FeedSource,
    private readonly options: FeedOptions = {},
  ) {}

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
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.setStatus({ state: "idle" });
  }

  private setStatus(patch: Partial<FeedStatus>): void {
    this.current = { ...this.current, ...patch };
    if (patch.state !== "error" && this.current.error) delete this.current.error;
    for (const l of this.statusListeners) l(this.current);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private filters(): rpc.Api.EventFilter[] {
    const ids = [this.source.contractId];
    if (this.options.includeToken && this.source.sacId) ids.push(this.source.sacId);
    return [{ type: "contract", contractIds: ids }];
  }

  /** The first request: a start ledger within the retention window, or a cursor. */
  private async firstRequest(limit: number): Promise<rpc.Api.GetEventsRequest> {
    const from = this.options.from ?? "retention-start";
    if (typeof from === "object" && "cursor" in from) return { filters: this.filters(), cursor: from.cursor, limit };
    const health = await this.source.server.getHealth();
    let startLedger = health.oldestLedger;
    let clamped = false;
    if (from === "now") startLedger = health.latestLedger;
    else if (typeof from === "object") {
      clamped = from.ledger < health.oldestLedger;
      startLedger = Math.min(Math.max(from.ledger, health.oldestLedger), health.latestLedger);
    }
    this.setStatus({ startLedger, clamped, oldestLedger: health.oldestLedger, latestLedger: health.latestLedger });
    return { filters: this.filters(), startLedger, limit };
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const limit = this.options.pageLimit ?? 1000;
    try {
      const request: rpc.Api.GetEventsRequest = this.current.cursor
        ? { filters: this.filters(), cursor: this.current.cursor, limit }
        : await this.firstRequest(limit);
      const response = await this.source.server.getEvents(request);
      if (!this.running) return;
      const batch = response.events.filter((e) => e.id > this.lastId).map((e) => this.decode(e));
      const last = batch.at(-1);
      if (last) this.lastId = last.eventId;
      this.failures = 0;
      const full = response.events.length >= limit;
      this.setStatus({
        state: full ? "backfilling" : "live",
        cursor: response.cursor,
        latestLedger: response.latestLedger,
        latestLedgerCloseTime: Number(response.latestLedgerCloseTime),
        oldestLedger: response.oldestLedger,
        oldestLedgerCloseTime: Number(response.oldestLedgerCloseTime),
      });
      if (batch.length) for (const l of this.listeners) l(batch);
      this.schedule(full ? 0 : (this.options.pollMs ?? 2000));
    } catch (e) {
      if (!this.running) return;
      const error = toRtgsError(e);
      // A cursor that fell out of the retention window: restart from its oldest ledger.
      if (this.current.cursor && /cursor|out of range|before|retention/i.test(error.detail)) {
        delete this.current.cursor;
        this.setStatus({ clamped: true });
      }
      this.failures += 1;
      this.setStatus({ state: "error", error });
      this.schedule(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures, 5)));
    }
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
