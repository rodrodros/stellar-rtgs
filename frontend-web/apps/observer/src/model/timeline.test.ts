import type { EventMeta } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { A, B, C, deposited, offset, reprioritised, revoked, settled, submitted, transfer, tx, withdrawn } from "../../test/events.ts";
import { addressesOf, categoryOf, explainSettlements, filterGroups, groupByTransaction, type Category } from "./timeline.ts";

describe("explainSettlements", () => {
  it("settles at once a payment order submitted and settled in the same transaction", () => {
    const events = tx(10, (m) => [submitted(m(), 0n, A, B, 5n), settled(m(), 0n, A, B, 5n)]);
    expect(explainSettlements(events)).toMatchObject([{ via: "at-once", event: { id: 0n } }]);
  });

  it("follows a cascade: a deposit releases A's head, whose credit to B releases B's head", () => {
    const events = tx(11, (m) => [
      deposited(m(), A, 300n),
      transfer(m(), A, "CSETTLEMENT", 300n),
      settled(m(), 0n, A, B, 300n),
      settled(m(), 1n, B, C, 200n),
      settled(m(), 2n, A, C, 0n),
    ]);
    expect(explainSettlements(events)).toEqual([
      expect.objectContaining({ via: "eager-closure", releasedBy: { kind: "trigger" }, event: expect.objectContaining({ id: 0n }) }),
      expect.objectContaining({ via: "eager-closure", releasedBy: { kind: "payment", id: 0n }, event: expect.objectContaining({ id: 1n }) }),
      expect.objectContaining({ via: "eager-closure", releasedBy: { kind: "trigger" }, event: expect.objectContaining({ id: 2n }) }),
    ]);
  });

  it("credits the latest earlier settlement into the sender, not the first", () => {
    const events = tx(12, (m) => [
      deposited(m(), C, 1n),
      settled(m(), 4n, C, A, 1n),
      settled(m(), 5n, B, A, 1n),
      settled(m(), 6n, A, B, 2n),
    ]);
    expect(explainSettlements(events).at(-1)).toMatchObject({ releasedBy: { kind: "payment", id: 5n } });
  });

  it.each([
    ["a revocation", (m: EventMeta) => revoked(m, 3n)],
    ["a reprioritisation", (m: EventMeta) => reprioritised(m, 3n, "urgent")],
  ])("names the trigger for a settlement after %s", (_, first) => {
    const events = tx(13, (m) => [first(m()), settled(m(), 4n, A, B, 1n)]);
    expect(explainSettlements(events)).toMatchObject([{ via: "eager-closure", releasedBy: { kind: "trigger" } }]);
  });

  it("marks the payment orders of an offset, and a submission settled by it is still an offset", () => {
    const events = tx(14, (m) => [
      submitted(m(), 9n, C, A, 5n),
      offset(m(), [7n, 8n, 9n]),
      settled(m(), 7n, A, B, 5n),
      settled(m(), 8n, B, C, 5n),
      settled(m(), 9n, C, A, 5n),
    ]);
    expect(explainSettlements(events).map((s) => s.via)).toEqual(["offset", "offset", "offset"]);
  });

  it("explains a later cascade settlement after an at-once one", () => {
    const events = tx(15, (m) => [submitted(m(), 5n, A, B, 1n), settled(m(), 5n, A, B, 1n), settled(m(), 3n, B, C, 1n)]);
    expect(explainSettlements(events)).toMatchObject([{ via: "at-once" }, { via: "eager-closure", releasedBy: { kind: "payment", id: 5n } }]);
  });
});

describe("groupByTransaction", () => {
  it("groups contiguous events of a transaction, with its trigger and settlements", () => {
    const events = [
      ...tx(20, (m) => [transfer(m(), "GISSUER", A, 1n)]),
      ...tx(21, (m) => [transfer(m(), A, "CSETTLEMENT", 9n), deposited(m(), A, 9n), settled(m(), 0n, A, B, 9n)]),
      ...tx(21, (m) => [withdrawn(m(), B, 1n)]),
    ];
    const groups = groupByTransaction(events);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.trigger).toBeUndefined();
    expect(groups[1]).toMatchObject({ ledger: 21, trigger: { type: "Deposited" }, settlements: [{ via: "eager-closure" }] });
    expect(groups[1]!.events).toHaveLength(3);
    expect(groups[2]!.trigger).toMatchObject({ type: "Withdrawn" });
  });

  it("leaves out the oldest transaction once older events were dropped, since it may be cut", () => {
    // The deposit was dropped: alone, the settlements would look released by a `Settled`.
    const cut = tx(22, (m) => [deposited(m(), A, 9n), settled(m(), 0n, A, B, 9n), settled(m(), 1n, B, C, 9n)]).slice(1);
    const events = [...cut, ...tx(23, (m) => [withdrawn(m(), B, 1n)])];
    expect(groupByTransaction(events).map((g) => g.ledger)).toEqual([22, 23]);
    expect(groupByTransaction(events, { truncated: true }).map((g) => g.ledger)).toEqual([23]);
  });
});

describe("filters", () => {
  const senders = new Map([[3n, C]]);
  const senderOf = (id: bigint) => senders.get(id);
  const groups = groupByTransaction([
    ...tx(30, (m) => [deposited(m(), A, 1n)]),
    ...tx(31, (m) => [submitted(m(), 3n, C, B, 1n)]),
    ...tx(32, (m) => [revoked(m(), 3n)]),
    ...tx(33, (m) => [transfer(m(), "GISSUER", A, 1n)]),
  ]);
  const all = new Set<Category>(["liquidity", "payments", "credit", "token", "other"]);

  it("categorises every event", () => {
    expect(groups.map((g) => categoryOf(g.events[0]!))).toEqual(["liquidity", "payments", "payments", "token"]);
  });

  it("filters by category", () => {
    expect(filterGroups(groups, { categories: new Set(["payments"]) }, senderOf).map((g) => g.ledger)).toEqual([31, 32]);
  });

  it("filters by bank, resolving a revocation to the payment order's sender", () => {
    expect(filterGroups(groups, { categories: all, bank: C }, senderOf).map((g) => g.ledger)).toEqual([31, 32]);
    expect(filterGroups(groups, { categories: all, bank: A }, senderOf).map((g) => g.ledger)).toEqual([30, 33]);
  });

  it("finds the addresses of an offset through its payment orders", () => {
    const [event] = tx(34, (m) => [offset(m(), [3n, 4n])]);
    expect(addressesOf(event!, senderOf)).toEqual([C]);
  });
});
