import { describe, expect, it } from "vitest";
import { applyEvents, emptyState, mergePayments } from "../src/model/reducer.ts";
import { analyseQueues, expirablePayments, expiresAt, isExpired } from "../src/model/queues.ts";
import { flowMatrix, netFlows } from "../src/model/flows.ts";
import type { Config, Payment, RtgsEvent } from "../src/types.ts";
import { A, B, C, meta } from "./helpers.ts";

const config: Config = { queueCap: 16, expirySecs: 100, repoTermSecs: 100, penaltyRateBps: 500 };

function ev<T extends RtgsEvent["type"]>(ledger: number, tx: string, body: Extract<RtgsEvent, { type: T }> extends infer E ? Omit<E, keyof ReturnType<typeof meta>> : never): RtgsEvent {
  return { ...meta(ledger, { txHash: tx }), ...(body as object) } as RtgsEvent;
}

const submitted = (ledger: number, tx: string, id: bigint, from = A, to = B, amount = 10n, priority: "urgent" | "normal" = "normal") =>
  ev<"Submitted">(ledger, tx, { type: "Submitted", id, from, to, amount, priority });
const settled = (ledger: number, tx: string, id: bigint, from = A, to = B, amount = 10n) =>
  ev<"Settled">(ledger, tx, { type: "Settled", id, from, to, amount });

describe("reducer", () => {
  it("marks a payment settled on submission as settled at once", () => {
    const s = applyEvents(emptyState(), [submitted(1, "t1", 0n), settled(1, "t1", 0n)]);
    const p = s.payments.get(0n)!;
    expect(p.status).toBe("settled");
    expect(p.steps.map((x) => x.kind)).toEqual(["submitted", "settled"]);
    expect(p.steps[1]).toMatchObject({ via: "at-once" });
  });

  it("attributes a later settlement to the action that released it", () => {
    const s = applyEvents(emptyState(), [
      submitted(1, "t1", 0n, A, B, 50n),
      ev<"Deposited">(2, "t2", { type: "Deposited", bank: A, amount: 50n }),
      settled(2, "t2", 0n, A, B, 50n),
      submitted(3, "t3", 1n, C, A, 5n),
      submitted(4, "t4", 2n, B, C, 5n),
      settled(4, "t4", 2n, B, C, 5n),
      settled(4, "t4", 1n, C, A, 5n),
    ]);
    expect(s.payments.get(0n)!.steps.at(-1)).toMatchObject({ via: "eager-closure", trigger: { type: "Deposited", actor: A } });
    expect(s.payments.get(2n)!.steps.at(-1)).toMatchObject({ via: "at-once" });
    expect(s.payments.get(1n)!.steps.at(-1)).toMatchObject({ via: "eager-closure", trigger: { type: "Submitted", actor: B, paymentId: 2n } });
  });

  it("marks settlements in an offset", () => {
    const s = applyEvents(emptyState(), [
      submitted(1, "t1", 0n, A, B),
      submitted(2, "t2", 1n, B, A),
      ev<"Offset">(2, "t2", { type: "Offset", ids: [0n, 1n] }),
      settled(2, "t2", 0n, A, B),
      settled(2, "t2", 1n, B, A),
    ]);
    expect(s.payments.get(0n)!.steps.at(-1)).toMatchObject({ via: "offset" });
    expect(s.payments.get(1n)!.steps.at(-1)).toMatchObject({ via: "offset" });
  });

  it("revokes, expires and reprioritises, and never reopens a final payment", () => {
    let s = applyEvents(emptyState(), [submitted(1, "t1", 0n), submitted(1, "t2", 1n)]);
    s = applyEvents(s, [
      ev<"Reprioritised">(2, "t3", { type: "Reprioritised", id: 0n, priority: "urgent" }),
      ev<"Revoked">(3, "t4", { type: "Revoked", id: 0n }),
      ev<"Expired">(4, "t5", { type: "Expired", id: 1n }),
    ]);
    expect(s.payments.get(0n)).toMatchObject({ status: "revoked", priority: "urgent" });
    expect(s.payments.get(1n)!.status).toBe("expired");
    const view: Payment = { id: 0n, from: A, to: B, amount: 10n, priority: "urgent", submittedAt: 1, status: "queued" };
    expect(mergePayments(s, [view]).payments.get(0n)!.status).toBe("revoked");
  });

  it("ignores events it has already applied (same event ids)", () => {
    const s = applyEvents(emptyState(), [submitted(1, "t1", 0n), settled(2, "t2", 0n)]);
    expect(applyEvents(s, s.events).payments).toEqual(s.payments);
  });

  it("marks a payment order known only from its settlement as partial until the views fill it in", () => {
    const s = applyEvents(emptyState(), [settled(5, "t5", 9n, A, B, 7n)]);
    expect(s.payments.get(9n)).toMatchObject({ status: "settled", partial: true });
    const view: Payment = { id: 9n, from: A, to: B, amount: 7n, priority: "urgent", submittedAt: 3, status: "settled", settledAt: 25 };
    const merged = mergePayments(s, [view]).payments.get(9n)!;
    expect(merged).toMatchObject({ priority: "urgent", submittedAt: 3, status: "settled" });
    expect(merged.partial).toBeUndefined();
    expect(merged.steps.map((x) => x.kind)).toEqual(["settled"]);
  });

  it("tracks repos and collateral", () => {
    const s = applyEvents(emptyState(), [
      ev<"CollateralSet">(1, "t1", { type: "CollateralSet", bank: A, value: 100n }),
      ev<"RepoOpened">(2, "t2", { type: "RepoOpened", id: 0n, bank: A, amount: 60n }),
      ev<"RepoRepaid">(3, "t3", { type: "RepoRepaid", id: 0n, amount: 20n, outstanding: 40n }),
      ev<"RepoPenalised">(4, "t4", { type: "RepoPenalised", id: 0n, rateBps: 500 }),
    ]);
    expect(s.collateral.get(A)).toBe(100n);
    expect(s.repos.get(0n)).toMatchObject({ outstanding: 40n, status: "penalty", rateBps: 500 });
    const repaid = applyEvents(s, [ev<"RepoRepaid">(5, "t5", { type: "RepoRepaid", id: 0n, amount: 40n, outstanding: 0n })]);
    expect(repaid.repos.get(0n)!.status).toBe("repaid");
  });

  it("collects the addresses events mention, and leaves the input state alone", () => {
    const before = emptyState();
    const after = applyEvents(before, [submitted(1, "t1", 0n, A, C)]);
    expect([...after.seen].sort()).toEqual([A, C].sort());
    expect(before.payments.size).toBe(0);
  });
});

describe("queue analysis", () => {
  const p = (id: bigint, amount: bigint, priority: "urgent" | "normal", submittedAt = 1000): Payment => ({
    id, from: A, to: B, amount, priority, submittedAt, status: "queued",
  });

  it("blocks normal payments behind queued urgent ones (S7)", () => {
    const q = analyseQueues(1000n, { urgent: [p(1n, 5000n, "urgent")], normal: [p(0n, 1n, "normal")] }, config);
    expect(q.urgent).toMatchObject({ length: 1, covered: false, blockedBy: "uncovered", expiresAt: 1100 });
    expect(q.normal).toMatchObject({ covered: true, blockedBy: "urgent-queued" });
  });

  it("reports an uncovered head and its expiry", () => {
    const q = analyseQueues(0n, { urgent: [], normal: [p(0n, 1n, "normal", 900)] }, config);
    expect(q.normal).toMatchObject({ blockedBy: "uncovered", expiresAt: 1000 });
    expect(q.urgent).toMatchObject({ length: 0, covered: false });
    expect(q.urgent.expiresAt).toBeUndefined();
    expect(expiresAt(p(0n, 1n, "normal", 5), config)).toBe(105);
  });

  it("expires strictly after the expiry, as the contract does (NotExpired at the boundary)", () => {
    const payment = p(0n, 1n, "normal", 900);
    expect(isExpired(payment, config, 1000)).toBe(false);
    expect(isExpired(payment, config, 1001)).toBe(true);
    expect(isExpired({ ...payment, status: "settled" }, config, 5000)).toBe(false);
  });

  it("lists every expirable queued payment order, not just heads, oldest first", () => {
    const list = [p(3n, 1n, "normal", 950), p(1n, 1n, "urgent", 800), p(2n, 1n, "normal", 990), { ...p(0n, 1n, "normal", 0), status: "revoked" as const }];
    expect(expirablePayments(list, config, 1060).map((x) => x.id)).toEqual([1n, 3n]);
  });

  it("covers exactly when the balance after paying is non-negative", () => {
    expect(analyseQueues(10n, { urgent: [p(0n, 10n, "urgent")], normal: [] }).urgent).toMatchObject({ covered: true });
    expect(analyseQueues(10n, { urgent: [p(0n, 10n, "urgent")], normal: [] }).urgent.blockedBy).toBeUndefined();
  });
});

describe("flows", () => {
  it("sums settled liquidity between banks and nets it", () => {
    const events = [settled(1, "t1", 0n, A, B, 10n), settled(2, "t2", 1n, A, B, 5n), settled(3, "t3", 2n, B, C, 7n), submitted(4, "t4", 3n)];
    const m = flowMatrix(events);
    expect(m.get(A)!.get(B)).toBe(15n);
    expect(m.get(B)!.get(C)).toBe(7n);
    expect(netFlows(m)).toEqual(new Map([[A, -15n], [B, 8n], [C, 7n]]));
    expect(flowMatrix(events, { sinceLedger: 3 }).get(A)).toBeUndefined();
  });
});
