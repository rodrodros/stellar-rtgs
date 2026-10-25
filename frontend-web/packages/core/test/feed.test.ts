import { Contract, rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorLedger, EventFeed } from "../src/events/feed.ts";
import type { RpcServer } from "../src/rpc.ts";
import type { FeedEvent } from "../src/types.ts";
import { A, addr, CB, CONTRACT, i128, map, SAC, sym } from "./helpers.ts";
import { xdr } from "@stellar/stellar-sdk";

function event(ledger: number, n: number, contractId = CONTRACT): rpc.Api.EventResponse {
  const topics = contractId === CONTRACT ? [sym("deposited"), addr(A)] : [sym("mint"), addr(A), xdr.ScVal.scvString(`USD:${CB}`)];
  return {
    id: `${String(ledger).padStart(19, "0")}-${String(n).padStart(10, "0")}`,
    type: "contract",
    ledger,
    ledgerClosedAt: new Date((1_800_000_000 + ledger) * 1000).toISOString(),
    transactionIndex: 1,
    operationIndex: 0,
    txHash: `tx${ledger}`,
    contractId: new Contract(contractId),
    topic: topics,
    value: contractId === CONTRACT ? map({ amount: i128(ledger) }) : i128(1),
  };
}

function fakeServer(pages: rpc.Api.EventResponse[][], health = { oldestLedger: 50, latestLedger: 200 }) {
  const requests: rpc.Api.GetEventsRequest[] = [];
  let call = 0;
  const server = {
    getHealth: vi.fn(async () => ({ status: "healthy", ledgerRetentionWindow: 120960, ...health })),
    getEvents: vi.fn(async (req: rpc.Api.GetEventsRequest) => {
      requests.push(req);
      const events = pages[call] ?? [];
      call += 1;
      return {
        events,
        cursor: `c${call}`,
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        latestLedgerCloseTime: "1800000200",
        oldestLedgerCloseTime: "1800000050",
      };
    }),
  };
  return { server: server as unknown as RpcServer, requests, mock: server };
}

afterEach(() => vi.useRealTimers());

async function drain(feed: EventFeed, ticks = 5) {
  for (let i = 0; i < ticks; i++) await vi.advanceTimersByTimeAsync(1000);
  feed.stop();
}

describe("event feed", () => {
  it("clamps a start before the retention window, pages by cursor and decodes", async () => {
    vi.useFakeTimers();
    const { server, requests } = fakeServer([[event(60, 1), event(61, 1)], [event(70, 1)]]);
    const feed = new EventFeed({ server, contractId: CONTRACT }, { from: { ledger: 10 }, pageLimit: 2, pollMs: 1000 });
    const got: FeedEvent[] = [];
    feed.subscribe((b) => got.push(...b));
    feed.start();
    await drain(feed);
    expect(requests[0]).toMatchObject({ startLedger: 50, limit: 2 });
    expect(requests[1]).toMatchObject({ cursor: "c1" });
    expect(got.map((e) => e.ledger)).toEqual([60, 61, 70]);
    expect(got[0]).toMatchObject({ type: "Deposited", bank: A, amount: 60n, closedAt: 1_800_000_060, contractId: CONTRACT });
    expect(feed.status()).toMatchObject({ clamped: true, startLedger: 50, oldestLedger: 50, latestLedgerCloseTime: 1_800_000_200 });
  });

  it("starts at the oldest retained ledger by default, or now", async () => {
    vi.useFakeTimers();
    const a = fakeServer([]);
    const f1 = new EventFeed({ server: a.server, contractId: CONTRACT });
    f1.start();
    await drain(f1, 1);
    expect(a.requests[0]).toMatchObject({ startLedger: 50 });
    const b = fakeServer([]);
    const f2 = new EventFeed({ server: b.server, contractId: CONTRACT }, { from: "now" });
    f2.start();
    await drain(f2, 1);
    expect(b.requests[0]).toMatchObject({ startLedger: 200 });
    expect(f2.status().clamped).toBe(false);
  });

  it("drops events it has already delivered", async () => {
    vi.useFakeTimers();
    const { server } = fakeServer([[event(60, 1)], [event(60, 1), event(61, 1)]]);
    const feed = new EventFeed({ server, contractId: CONTRACT }, { pollMs: 100 });
    const got: FeedEvent[] = [];
    feed.subscribe((b) => got.push(...b));
    feed.start();
    await drain(feed);
    expect(got.map((e) => e.eventId)).toEqual([event(60, 1).id, event(61, 1).id]);
  });

  it("follows the cash token's SAC when asked, as token events", async () => {
    vi.useFakeTimers();
    const { server, requests } = fakeServer([[event(60, 1, SAC)]]);
    const feed = new EventFeed({ server, contractId: CONTRACT, sacId: SAC }, { includeToken: true });
    const got: FeedEvent[] = [];
    feed.subscribe((b) => got.push(...b));
    feed.start();
    await drain(feed, 1);
    expect(requests[0]!.filters).toEqual([{ type: "contract", contractIds: [CONTRACT, SAC] }]);
    expect(got[0]).toMatchObject({ type: "Token", action: "mint", to: A, amount: 1n });
  });

  it("reports an RPC failure and retries with backoff", async () => {
    vi.useFakeTimers();
    const { server, mock } = fakeServer([[event(60, 1)]]);
    mock.getEvents.mockRejectedValueOnce(new TypeError("fetch failed"));
    const feed = new EventFeed({ server, contractId: CONTRACT }, { pollMs: 1000 });
    const states: string[] = [];
    feed.onStatus((s) => states.push(s.state));
    const got: FeedEvent[] = [];
    feed.subscribe((b) => got.push(...b));
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.status()).toMatchObject({ state: "error", error: { kind: "rpc" } });
    await drain(feed, 4);
    expect(got).toHaveLength(1);
    expect(states).toContain("live");
  });
});

const toidCursor = (ledger: number) => `${((BigInt(ledger + 1) << 32n) - 1n).toString().padStart(19, "0")}-4294967295`;
const RANGE_ERROR = { code: -32600, message: "startLedger must be within the ledger range: 50 - 200" };

describe("event feed recovery and progress", () => {
  it("reads the ledger from a cursor", () => {
    expect(cursorLedger(toidCursor(55))).toBe(55);
    expect(cursorLedger("0000000240518168575-4294967295")).toBe(55);
    expect(cursorLedger("nonsense")).toBeUndefined();
  });

  it("keeps fetching without delay, as backfilling, until the cursor reaches the latest ledger", async () => {
    vi.useFakeTimers();
    const { server, mock } = fakeServer([]);
    const cursors = [toidCursor(10_049), toidCursor(20_049), toidCursor(200)];
    let call = 0;
    mock.getEvents.mockImplementation(async () => ({
      events: [],
      cursor: cursors[Math.min(call++, 2)]!,
      latestLedger: call <= 2 ? 30_000 : 200,
      oldestLedger: 50,
      latestLedgerCloseTime: "1800000200",
      oldestLedgerCloseTime: "1800000050",
    }));
    const feed = new EventFeed({ server, contractId: CONTRACT }, { pollMs: 60_000 });
    const states: string[] = [];
    feed.onStatus((s) => states.push(s.state));
    feed.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(mock.getEvents).toHaveBeenCalledTimes(3);
    expect(states.filter((s) => s !== "idle")).toEqual(["backfilling", "backfilling", "live"]);
    expect(feed.status()).toMatchObject({ cursorLedger: 200, retentionWindow: 120960 });
    feed.stop();
  });

  it("restarts from the oldest retained ledger when its cursor fell out of the window", async () => {
    vi.useFakeTimers();
    const { server, mock, requests } = fakeServer([[event(60, 1)], [], [event(70, 1)]]);
    const feed = new EventFeed({ server, contractId: CONTRACT }, { pollMs: 1000 });
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    mock.getEvents.mockRejectedValueOnce(RANGE_ERROR);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(10);
    feed.stop();
    expect(requests.at(-1)).toMatchObject({ startLedger: 50 });
    expect(feed.status()).toMatchObject({ clamped: true });
  });

  it("recovers from a saved cursor that is out of the window, too", async () => {
    vi.useFakeTimers();
    const { server, mock, requests } = fakeServer([[event(60, 1)]]);
    mock.getEvents.mockRejectedValueOnce(RANGE_ERROR);
    const feed = new EventFeed({ server, contractId: CONTRACT }, { from: { cursor: toidCursor(2) } });
    const got: FeedEvent[] = [];
    feed.subscribe((b) => got.push(...b));
    feed.start();
    await vi.advanceTimersByTimeAsync(10);
    feed.stop();
    expect(mock.getEvents.mock.calls[0]![0]).toMatchObject({ cursor: toidCursor(2) });
    expect(requests[0]).toMatchObject({ startLedger: 50 });
    expect(got).toHaveLength(1);
    expect(feed.status().clamped).toBe(true);
  });

  it("runs one polling loop after stop() and start() in quick succession", async () => {
    vi.useFakeTimers();
    const { server, mock } = fakeServer([]);
    mock.getEvents.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { events: [], cursor: toidCursor(200), latestLedger: 200, oldestLedger: 50, latestLedgerCloseTime: "1", oldestLedgerCloseTime: "1" };
    });
    const feed = new EventFeed({ server, contractId: CONTRACT }, { pollMs: 100 });
    feed.start();
    feed.stop();
    feed.start();
    await vi.advanceTimersByTimeAsync(2000);
    feed.stop();
    // One loop: a call every ~150 ms (50 ms request + 100 ms poll); two loops would double it.
    expect(mock.getEvents.mock.calls.length).toBeLessThanOrEqual(15);
  });

  it("tells its owner when it starts and stops", () => {
    const { server } = fakeServer([]);
    const started = vi.fn();
    const stopped = vi.fn();
    const feed = new EventFeed({ server, contractId: CONTRACT }, {}, { onStart: started, onStop: stopped });
    feed.start();
    feed.stop();
    expect(started).toHaveBeenCalledWith(feed);
    expect(stopped).toHaveBeenCalledWith(feed);
  });
});

describe("event feed robustness", () => {
  it("recovers from a stale cursor even after another error came first", async () => {
    vi.useFakeTimers();
    const { server, mock } = fakeServer([[event(60, 1)]]);
    const feed = new EventFeed({ server, contractId: CONTRACT }, { pollMs: 1000 });
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    mock.getEvents.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mock.getEvents.mockRejectedValueOnce(RANGE_ERROR);
    await vi.advanceTimersByTimeAsync(1000); // poll: network error
    await vi.advanceTimersByTimeAsync(2000); // backoff: out of range, restart from the window
    await vi.advanceTimersByTimeAsync(10);
    feed.stop();
    const calls = mock.getEvents.mock.calls.map((c) => c[0]);
    expect(calls.at(-1)).toMatchObject({ startLedger: 50 });
    expect(feed.status()).toMatchObject({ clamped: true });
  });

  it("doesn't change a status object it already published", async () => {
    vi.useFakeTimers();
    const { server, mock } = fakeServer([[event(60, 1)]]);
    const feed = new EventFeed({ server, contractId: CONTRACT }, { pollMs: 1000 });
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    const published = feed.status();
    const cursor = published.cursor;
    mock.getEvents.mockRejectedValueOnce(RANGE_ERROR);
    await vi.advanceTimersByTimeAsync(1000);
    feed.stop();
    expect(published.cursor).toBe(cursor);
  });

  it("keeps delivering to other listeners, and stays live, when one listener throws", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    try {
      const { server } = fakeServer([[event(60, 1)]]);
      const feed = new EventFeed({ server, contractId: CONTRACT });
      const got: FeedEvent[] = [];
      feed.subscribe(() => {
        throw new Error("app bug");
      });
      feed.subscribe((b) => got.push(...b));
      feed.start();
      await vi.advanceTimersByTimeAsync(0);
      feed.stop();
      expect(got).toHaveLength(1);
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "app bug" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("delivers the batch and stays live when a status listener throws", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    try {
      const { server } = fakeServer([[event(60, 1)]]);
      const feed = new EventFeed({ server, contractId: CONTRACT });
      const got: FeedEvent[] = [];
      feed.onStatus(() => {
        throw new Error("status bug");
      });
      feed.subscribe((b) => got.push(...b));
      feed.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(got).toHaveLength(1);
      expect(feed.status().state).toBe("live");
      expect(report).toHaveBeenCalled();
      feed.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
