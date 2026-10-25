import type { FeedEvent, PaymentRecord, Repo, RtgsEventBody } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { lastTouching, touches } from "./touches.ts";

const ME = "GME";
const OTHER = "GOTHER";
let seq = 0;
const ev = (body: RtgsEventBody | { type: "Token"; action: string; from?: string; to?: string }): FeedEvent =>
  ({ ...body, eventId: String(++seq).padStart(10, "0"), ledger: seq, closedAt: seq, txHash: `tx${seq}`, contractId: "C" }) as FeedEvent;

const payment = (id: bigint, from: string, to: string): PaymentRecord => ({
  id,
  from,
  to,
  amount: 1n,
  priority: "normal",
  submittedAt: 0,
  status: "queued",
  steps: [],
});
const lookups = {
  payments: new Map([
    [1n, payment(1n, ME, OTHER)],
    [2n, payment(2n, OTHER, "GTHIRD")],
  ]),
  repos: new Map<bigint, Repo>([[7n, { id: 7n, bank: ME, amount: 1n, outstanding: 1n, openedAt: 0, status: "intraday", rateBps: 0 }]]),
};

describe("touches", () => {
  it("matches events that name the bank", () => {
    expect(touches(ev({ type: "Deposited", bank: ME, amount: 1n }), ME, lookups)).toBe(true);
    expect(touches(ev({ type: "Deposited", bank: OTHER, amount: 1n }), ME, lookups)).toBe(false);
    expect(touches(ev({ type: "Settled", id: 3n, from: OTHER, to: ME, amount: 1n }), ME, lookups)).toBe(true);
    expect(touches(ev({ type: "Token", action: "transfer", from: OTHER, to: ME }), ME, lookups)).toBe(true);
  });

  it("resolves id-only events through the payment orders and repos", () => {
    expect(touches(ev({ type: "Revoked", id: 1n }), ME, lookups)).toBe(true);
    expect(touches(ev({ type: "Expired", id: 2n }), ME, lookups)).toBe(false);
    expect(touches(ev({ type: "Reprioritised", id: 9n, priority: "urgent" }), ME, lookups)).toBe(false);
    expect(touches(ev({ type: "Offset", ids: [2n, 1n] }), ME, lookups)).toBe(true);
    expect(touches(ev({ type: "RepoRepaid", id: 7n, amount: 1n, outstanding: 0n }), ME, lookups)).toBe(true);
    expect(touches(ev({ type: "RepoPenalised", id: 8n, rateBps: 500 }), ME, lookups)).toBe(false);
  });

  it("keys on the newest event that concerns the bank", () => {
    const mine = ev({ type: "Deposited", bank: ME, amount: 1n });
    const theirs = ev({ type: "Deposited", bank: OTHER, amount: 1n });
    expect(lastTouching({ ...lookups, events: [mine, theirs] }, ME)).toBe(mine.eventId);
    expect(lastTouching({ ...lookups, events: [theirs] }, ME)).toBe("");
    const repaid = ev({ type: "RepoRepaid", id: 7n, amount: 1n, outstanding: 0n });
    expect(lastTouching({ ...lookups, events: [repaid, mine] }, ME, new Set(["RepoRepaid"]))).toBe(repaid.eventId);
  });
});
