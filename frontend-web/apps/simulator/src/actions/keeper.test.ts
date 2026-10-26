import type { Repo } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { BANK_1, BANK_2, CB, CONFIG, TUNING, USD, bank, fakeActors, fakeWorld, payment } from "../../test/fakes.ts";
import { createRng } from "../rng.ts";
import type { PlanContext, WorldView } from "../types.ts";
import { convertOverdue, expire, keeperActions } from "./keeper.ts";

const ctx = (world: WorldView): PlanContext => ({ world, rng: createRng(1), actor: CB, tuning: TUNING });

const repo = (over: Partial<Repo> = {}): Repo => ({
  id: 0n,
  bank: BANK_1,
  amount: 500n * USD,
  outstanding: 500n * USD,
  openedAt: 1_000,
  status: "intraday",
  rateBps: 0,
  ...over,
});

describe("keeperActions", () => {
  it("are the central bank's, gated on their capabilities", () => {
    expect(keeperActions.group).toBe("keeper");
    expect(keeperActions.actions.map((a) => [a.name, a.role, a.capability])).toEqual([
      ["expire", "central-bank", "expire"],
      ["convertOverdue", "central-bank", "convertOverdue"],
    ]);
  });
});

describe("expire", () => {
  it("waits until a queued order is strictly past its expiry, then takes the oldest", () => {
    const older = payment({ submittedAt: 1_000 });
    const newer = payment({ submittedAt: 1_000, from: BANK_2 });
    const world = fakeWorld({
      banks: [bank(BANK_1, { queues: { urgent: [], normal: [older] } }), bank(BANK_2, { queues: { urgent: [newer], normal: [] } })],
    });
    world.state.now = 1_000 + CONFIG.expirySecs;
    expect(expire.plan(ctx(world))).toBeUndefined();
    world.state.now += 1;
    expect(expire.plan(ctx(world))).toEqual({ id: older.id, from: "Bank 1" });
  });

  it("expires through the central bank", async () => {
    const actors = fakeActors();
    await expire.run(actors, CB, { id: 7n, from: "Bank 1" });
    expect(actors.calls).toEqual([{ as: CB, method: "expire", args: [7n] }]);
    expect(expire.describe({ id: 7n, from: "Bank 1" })).toBe("#7 from Bank 1");
  });
});

describe("convertOverdue", () => {
  it("waits until an intraday repo is strictly past its term, then takes the oldest", () => {
    const world = fakeWorld({ repos: [repo({ id: 3n }), repo({ id: 1n }), repo({ id: 0n, status: "penalty" })] });
    world.state.now = 1_000 + CONFIG.repoTermSecs;
    expect(convertOverdue.plan(ctx(world))).toBeUndefined();
    world.state.now += 1;
    expect(convertOverdue.plan(ctx(world))).toEqual({ repoId: 1n, bank: "Bank 1" });
  });

  it("converts through the central bank", async () => {
    const actors = fakeActors();
    await convertOverdue.run(actors, CB, { repoId: 2n, bank: "Bank 1" });
    expect(actors.calls).toEqual([{ as: CB, method: "convertOverdue", args: [2n] }]);
  });
});
