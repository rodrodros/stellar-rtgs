import { describe, expect, it } from "vitest";
import { BANK_1, BANK_2, BANK_3, CONFIG, TUNING, USD, bank, fakeActors, fakeWorld, payment } from "../../test/fakes.ts";
import { createRng } from "../rng.ts";
import type { PlanContext, Tuning, WorldView } from "../types.ts";
import { deposit, paymentActions, reprioritise, revoke, submit, withdraw, type SubmitParams } from "./payments.ts";

const ctx = (world: WorldView, over: Partial<PlanContext> = {}): PlanContext => ({
  world,
  rng: createRng(1),
  actor: BANK_1,
  tuning: TUNING,
  ...over,
});

/** Plans `n` times with seeds 0..n-1, for bounds that must hold whatever the draw. */
const plans = <P>(plan: (c: PlanContext) => P | undefined, world: WorldView, over: Partial<PlanContext> = {}, n = 200) =>
  Array.from({ length: n }, (_, seed) => plan(ctx(world, { rng: createRng(seed), ...over })));

const only = (shape: keyof Tuning["submitMix"]): Tuning => ({
  ...TUNING,
  submitMix: { covered: 0, uncovered: 0, gridlock: 0, [shape]: 1 },
});

describe("paymentActions", () => {
  it("holds the five bank actions of the payments group", () => {
    expect(paymentActions.group).toBe("payments");
    expect(paymentActions.actions.map((a) => a.name)).toEqual(["deposit", "withdraw", "submit", "revoke", "reprioritise"]);
    for (const a of paymentActions.actions) {
      expect(a.group).toBe("payments");
      expect(a.role).toBe("bank");
      expect(a.capability).toBe(a.name);
    }
  });
});

describe("deposit", () => {
  it("doesn't apply to a deauthorized trustline, an empty holding or an unknown bank", () => {
    expect(deposit.plan(ctx(fakeWorld({ banks: [bank(BANK_1, { authorized: false }), bank(BANK_2)] })))).toBeUndefined();
    expect(deposit.plan(ctx(fakeWorld({ banks: [bank(BANK_1, { holding: 0n }), bank(BANK_2)] })))).toBeUndefined();
    expect(deposit.plan(ctx(fakeWorld(), { actor: "GUNKNOWN" }))).toBeUndefined();
  });

  it("deposits a slice of the holding that leaves half the floor", () => {
    const world = fakeWorld();
    const keep = TUNING.holdingFloor / 2n;
    for (const p of plans(deposit.plan, world)) {
      expect(p!.releases).toBe(false);
      expect(p!.amount).toBeGreaterThanOrEqual(TUNING.paymentSize.min);
      expect(p!.amount).toBeLessThanOrEqual(5_000n * USD - keep);
    }
  });

  it("deposits from a holding below half the floor, up to all of it", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { holding: 3n }), bank(BANK_2)] });
    for (const p of plans(deposit.plan, world)) expect(p!.amount >= 1n && p!.amount <= 3n).toBe(true);
  });

  it("covers the queue heads when the balance can't", () => {
    const heads = { urgent: [payment({ amount: 300n * USD, priority: "urgent" })], normal: [payment({ amount: 900n * USD })] };
    const world = fakeWorld({ banks: [bank(BANK_1, { balance: 200n * USD, queues: heads }), bank(BANK_2)] });
    for (const p of plans(deposit.plan, world)) {
      expect(p!.releases).toBe(true);
      expect(p!.amount).toBeGreaterThanOrEqual(1_000n * USD);
      expect(p!.amount).toBeLessThanOrEqual(5_000n * USD - TUNING.holdingFloor / 2n);
    }
  });

  it("dips into the reserve when that's what releasing the queue takes", () => {
    const heads = { urgent: [], normal: [payment({ amount: 5_000n * USD })] };
    const world = fakeWorld({ banks: [bank(BANK_1, { balance: 600n * USD, queues: heads, holding: 4_600n * USD }), bank(BANK_2)] });
    expect(deposit.plan(ctx(world))).toEqual({ amount: 4_400n * USD, releases: true });
    world.state.banks[0]!.holding = 1_000n * USD;
    expect(deposit.plan(ctx(world))).toEqual({ amount: 1_000n * USD, releases: false });
  });

  it("runs the bank's deposit and touches its trustline", async () => {
    const actors = fakeActors();
    await deposit.run(actors, BANK_1, { amount: 7n, releases: false });
    expect(actors.calls).toEqual([{ as: BANK_1, method: "deposit", args: [7n] }]);
    expect(deposit.touches(BANK_1, { amount: 7n, releases: false })).toEqual([BANK_1]);
    expect(deposit.describe({ amount: 250n * USD, releases: true })).toBe("250 USD, to release its queue");
  });
});

describe("withdraw", () => {
  it("doesn't apply to a deauthorized trustline or an empty balance", () => {
    expect(withdraw.plan(ctx(fakeWorld({ banks: [bank(BANK_1, { authorized: false }), bank(BANK_2)] })))).toBeUndefined();
    expect(withdraw.plan(ctx(fakeWorld({ banks: [bank(BANK_1, { balance: 0n }), bank(BANK_2)] })))).toBeUndefined();
  });

  it("leaves what the queue heads need", () => {
    const heads = { urgent: [payment({ amount: 300n * USD, priority: "urgent" })], normal: [payment({ amount: 100n * USD })] };
    const world = fakeWorld({ banks: [bank(BANK_1, { balance: 1_000n * USD, queues: heads }), bank(BANK_2)] });
    for (const p of plans(withdraw.plan, world)) {
      expect(p!.amount).toBeGreaterThanOrEqual(1n);
      expect(p!.amount).toBeLessThanOrEqual(600n * USD);
    }
  });

  it("takes a tenth at most when the heads need it all", () => {
    const heads = { urgent: [], normal: [payment({ amount: 2_000n * USD })] };
    const world = fakeWorld({ banks: [bank(BANK_1, { balance: 1_000n * USD, queues: heads }), bank(BANK_2)] });
    for (const p of plans(withdraw.plan, world)) expect(p!.amount >= 1n && p!.amount <= 100n * USD).toBe(true);
    world.state.banks[0]!.balance = 5n;
    expect(withdraw.plan(ctx(world))).toEqual({ amount: 1n });
  });

  it("runs the bank's withdraw and touches its trustline", async () => {
    const actors = fakeActors();
    await withdraw.run(actors, BANK_2, { amount: 9n });
    expect(actors.calls).toEqual([{ as: BANK_2, method: "withdraw", args: [9n] }]);
    expect(withdraw.touches(BANK_2, { amount: 9n })).toEqual([BANK_2]);
  });
});

describe("submit", () => {
  it("doesn't apply with a single bank", () => {
    expect(submit.plan(ctx(fakeWorld({ banks: [bank(BANK_1)] })))).toBeUndefined();
  });

  it("pays another bank, a covered amount, settling at once", () => {
    const world = fakeWorld();
    const results = plans(submit.plan, world, { tuning: only("covered") });
    for (const p of results) {
      expect(p!.shape).toBe("covered");
      expect([BANK_2, BANK_3]).toContain(p!.to);
      expect(p!.toLabel).toBe(`Bank ${p!.to.slice(-1)}`);
      expect(p!.amount).toBeGreaterThanOrEqual(TUNING.paymentSize.min);
      expect(p!.amount).toBeLessThanOrEqual(TUNING.paymentSize.max);
    }
    const urgent = results.filter((p) => p!.priority === "urgent").length;
    expect(urgent).toBeGreaterThan(20);
    expect(urgent).toBeLessThan(90);
  });

  it("keeps a covered payment within a small balance", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { balance: 3n }), bank(BANK_2)] });
    for (const p of plans(submit.plan, world, { tuning: only("covered") })) expect(p!.amount >= 1n && p!.amount <= 3n).toBe(true);
  });

  it("makes a covered payment urgent when normal ones are queued, so nothing is ahead of it", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { queues: { urgent: [], normal: [payment()] } }), bank(BANK_2)] });
    for (const p of plans(submit.plan, world, { tuning: only("covered") })) expect(p).toMatchObject({ shape: "covered", priority: "urgent" });
  });

  it("queues when covered can't settle at once and there is headroom, and otherwise does nothing", () => {
    const urgentQueued = { urgent: [payment({ priority: "urgent", amount: 5_000n * USD })], normal: [] };
    const world = fakeWorld({ banks: [bank(BANK_1, { queues: urgentQueued }), bank(BANK_2)] });
    expect(submit.plan(ctx(world, { tuning: only("covered") }))).toMatchObject({ shape: "uncovered" });
    world.state.queuedCount = CONFIG.queueCap - TUNING.queueHeadroom;
    expect(submit.plan(ctx(world, { tuning: only("covered") }))).toBeUndefined();
    world.state.banks[0] = bank(BANK_1, { balance: 0n });
    expect(submit.plan(ctx(world, { tuning: only("covered") }))).toBeUndefined();
  });

  it("queues an uncovered payment: above the balance by at most the largest payment", () => {
    const world = fakeWorld();
    for (const p of plans(submit.plan, world, { tuning: only("uncovered") })) {
      expect(p!.shape).toBe("uncovered");
      expect(p!.to).not.toBe(BANK_1);
      expect(p!.amount).toBeGreaterThan(1_000n * USD);
      expect(p!.amount).toBeLessThanOrEqual(1_000n * USD + TUNING.paymentSize.max);
    }
  });

  it("falls back to covered when the queue is at its headroom", () => {
    const world = fakeWorld({ queuedCount: CONFIG.queueCap - TUNING.queueHeadroom });
    for (const shape of ["uncovered", "gridlock"] as const) {
      for (const p of plans(submit.plan, world, { tuning: only(shape) }, 20)) {
        expect(p!.shape).toBe("covered");
        expect(p!.amount).toBeLessThanOrEqual(1_000n * USD);
      }
    }
  });

  it("falls back to covered with no crossing order to gridlock against", () => {
    const away = payment({ from: BANK_2, to: BANK_3, amount: 2_000n * USD });
    const world = fakeWorld({ banks: [bank(BANK_1), bank(BANK_2, { queues: { urgent: [], normal: [away] } }), bank(BANK_3)] });
    expect(submit.plan(ctx(world, { tuning: only("gridlock") }))).toMatchObject({ shape: "covered" });
  });

  it("crosses the payee's first queued order back, so the two net to non-negative balances", () => {
    const back = payment({ from: BANK_2, to: BANK_1, amount: 1_500n * USD });
    const world = fakeWorld({
      banks: [bank(BANK_1, { balance: 400n * USD }), bank(BANK_2, { balance: 200n * USD, queues: { urgent: [], normal: [back] } }), bank(BANK_3)],
    });
    for (const p of plans(submit.plan, world, { tuning: only("gridlock") })) {
      expect(p).toMatchObject({ shape: "gridlock", to: BANK_2, toLabel: "Bank 2", crosses: back.id });
      // It queues (above our balance), and both banks stay non-negative once the two net.
      expect(p!.amount).toBeGreaterThan(400n * USD);
      expect(400n * USD + back.amount - p!.amount).toBeGreaterThanOrEqual(0n);
      expect(200n * USD + p!.amount - back.amount).toBeGreaterThanOrEqual(0n);
    }
  });

  it("doesn't gridlock at the headroom, even with a crossing order", () => {
    const back = payment({ from: BANK_2, to: BANK_1, amount: 1_500n * USD });
    const world = fakeWorld({
      banks: [bank(BANK_1, { balance: 400n * USD }), bank(BANK_2, { balance: 200n * USD, queues: { urgent: [], normal: [back] } })],
    });
    expect(submit.plan(ctx(world, { tuning: only("gridlock") }))).toMatchObject({ shape: "gridlock" });
    world.state.queuedCount = CONFIG.queueCap - TUNING.queueHeadroom;
    for (const p of plans(submit.plan, world, { tuning: only("gridlock") }, 20)) {
      expect(p).toMatchObject({ shape: "covered" });
      expect(p!.amount).toBeLessThanOrEqual(400n * USD);
    }
  });

  it("only crosses an order that is first in its sender's queue", () => {
    const urgent = payment({ from: BANK_2, to: BANK_3, priority: "urgent", amount: 2_000n * USD });
    const back = payment({ from: BANK_2, to: BANK_1, amount: 1_500n * USD });
    const world = fakeWorld({ banks: [bank(BANK_1), bank(BANK_2, { queues: { urgent: [urgent], normal: [back] } }), bank(BANK_3)] });
    expect(submit.plan(ctx(world, { tuning: only("gridlock") }))).toMatchObject({ shape: "covered" });
  });

  it("puts a gridlock order first in our queue: none while urgent ones are queued, urgent ahead of normal ones", () => {
    const back = payment({ from: BANK_2, to: BANK_1, amount: 1_500n * USD });
    const banks = (queues: { urgent: ReturnType<typeof payment>[]; normal: ReturnType<typeof payment>[] }) => [
      bank(BANK_1, { queues }),
      bank(BANK_2, { queues: { urgent: [], normal: [back] } }),
    ];
    const normalQueued = fakeWorld({ banks: banks({ urgent: [], normal: [payment({ to: BANK_2 })] }) });
    for (const p of plans(submit.plan, normalQueued, { tuning: only("gridlock") }, 20)) expect(p).toMatchObject({ shape: "gridlock", priority: "urgent" });
    const urgentQueued = fakeWorld({ banks: banks({ urgent: [payment({ to: BANK_2, priority: "urgent" })], normal: [] }) });
    expect(submit.plan(ctx(urgentQueued, { tuning: only("gridlock") }))).toMatchObject({ shape: "uncovered" });
  });

  it("is repeatable for a seed", () => {
    const world = fakeWorld();
    expect(plans(submit.plan, world, {}, 20)).toEqual(plans(submit.plan, world, {}, 20));
  });

  it("runs the bank's submit with the planned order", async () => {
    const actors = fakeActors();
    const p: SubmitParams = { to: BANK_2, toLabel: "Bank 2", amount: 100n * USD, priority: "urgent", shape: "gridlock", crosses: 4n };
    await submit.run(actors, BANK_1, p);
    expect(actors.calls).toEqual([{ as: BANK_1, method: "submit", args: [{ to: BANK_2, amount: 100n * USD, priority: "urgent" }] }]);
    expect(submit.touches(BANK_1, p)).toEqual([]);
    expect(submit.describe(p)).toBe("100 USD to Bank 2 (urgent, gridlock against #4)");
    expect(submit.describe({ ...p, shape: "covered", crosses: undefined })).toBe("100 USD to Bank 2 (urgent, covered)");
  });
});

describe("revoke", () => {
  it("doesn't apply without a queued payment order of its own", () => {
    const theirs = payment({ from: BANK_2, to: BANK_1 });
    const world = fakeWorld({ banks: [bank(BANK_1), bank(BANK_2, { queues: { urgent: [], normal: [theirs] } })] });
    expect(revoke.plan(ctx(world))).toBeUndefined();
  });

  it("picks one of its own queued payment orders", async () => {
    const mine = [payment({ to: BANK_2 }), payment({ to: BANK_3 })];
    const world = fakeWorld({ banks: [bank(BANK_1, { queues: { urgent: [], normal: mine } }), bank(BANK_2), bank(BANK_3)] });
    const ids = new Set(plans(revoke.plan, world, {}, 50).map((p) => p!.id));
    expect(ids).toEqual(new Set(mine.map((p) => p.id)));
    const p = revoke.plan(ctx(world))!;
    const picked = mine.find((m) => m.id === p.id)!;
    expect(p).toEqual({ id: picked.id, amount: picked.amount, toLabel: `Bank ${picked.to.slice(-1)}` });

    const actors = fakeActors();
    await revoke.run(actors, BANK_1, p);
    expect(actors.calls).toEqual([{ as: BANK_1, method: "revoke", args: [p.id] }]);
    expect(revoke.touches(BANK_1, p)).toEqual([]);
    expect(revoke.describe({ id: 3n, amount: 100n * USD, toLabel: "Bank 2" })).toBe("#3, 100 USD to Bank 2");
  });
});

describe("reprioritise", () => {
  it("doesn't apply without a queued payment order of its own", () => {
    expect(reprioritise.plan(ctx(fakeWorld()))).toBeUndefined();
    const theirs = payment({ from: BANK_2, to: BANK_1 });
    const world = fakeWorld({ banks: [bank(BANK_1), bank(BANK_2, { queues: { urgent: [], normal: [theirs] } })] });
    expect(reprioritise.plan(ctx(world))).toBeUndefined();
  });

  it("moves an own queued payment order to the other class", async () => {
    const urgent = payment({ priority: "urgent" });
    const normal = payment();
    const world = fakeWorld({ banks: [bank(BANK_1, { queues: { urgent: [urgent], normal: [normal] } }), bank(BANK_2)] });
    for (const p of plans(reprioritise.plan, world, {}, 50)) {
      expect(p!.priority).toBe(p!.id === urgent.id ? "normal" : "urgent");
    }

    const actors = fakeActors();
    const p = { id: normal.id, amount: normal.amount, toLabel: "Bank 2", priority: "urgent" as const };
    await reprioritise.run(actors, BANK_1, p);
    expect(actors.calls).toEqual([{ as: BANK_1, method: "reprioritise", args: [normal.id, "urgent"] }]);
    expect(reprioritise.touches(BANK_1, p)).toEqual([]);
    expect(reprioritise.describe(p)).toBe(`#${normal.id}, 100 USD to Bank 2, to urgent`);
  });
});
