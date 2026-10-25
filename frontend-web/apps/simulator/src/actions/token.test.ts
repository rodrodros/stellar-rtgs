import { describe, expect, it } from "vitest";
import { BANK_1, BANK_2, BANK_3, CB, TUNING, USD, bank, fakeActors, fakeWorld, txOutcome } from "../../test/fakes.ts";
import { createRng } from "../rng.ts";
import type { ActionDef, ActionModule, ActionName, PlanContext, World } from "../types.ts";
import { createTokenActions, type DeauthorizeParams, type ReauthorizeParams, type TokenAmountParams } from "./token.ts";

const { holdingFloor: FLOOR, holdingCeiling: CEILING } = TUNING;

function action<P>(module: ActionModule, name: ActionName): ActionDef<P> {
  const found = module.actions.find((a) => a.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found as ActionDef<P>;
}

function ctx(world: World, seed = 1): PlanContext {
  return { world, rng: createRng(seed), actor: CB, tuning: TUNING };
}

/** Plans under many seeds, so a boundary holds whatever the RNG draws. */
function planMany<P>(a: ActionDef<P>, world: World, runs = 200): (P | undefined)[] {
  return Array.from({ length: runs }, (_, seed) => a.plan(ctx(world, seed)));
}

describe("tokenActions", () => {
  it("declares four central-bank actions in the token group", () => {
    const m = createTokenActions();
    expect(m.group).toBe("token");
    expect(m.actions.map((a) => a.name)).toEqual(["issue", "clawback", "deauthorize", "reauthorize"]);
    for (const a of m.actions) {
      expect(a.group).toBe("token");
      expect(a.role).toBe("central-bank");
      expect(a.capability).toBeUndefined();
    }
  });
});

describe("issue", () => {
  const issue = action<TokenAmountParams>(createTokenActions(), "issue");

  it("tops a bank below the floor up to between the floor and the ceiling", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { holding: FLOOR - 1n }), bank(BANK_2), bank(BANK_3)] });
    for (const p of planMany(issue, world)) {
      expect(p?.bank).toBe(BANK_1);
      expect(p?.label).toBe("Bank 1");
      const after = FLOOR - 1n + p!.amount;
      expect(after >= FLOOR && after <= CEILING).toBe(true);
    }
  });

  it("doesn't treat a holding at the floor as low", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { holding: FLOOR })] });
    const plans = planMany(issue, world).filter((p) => p !== undefined);
    // Only the rare small top-up, never one up to the floor band.
    expect(plans.length).toBeLessThan(40);
    for (const p of plans) expect(p.amount <= TUNING.paymentSize.max).toBe(true);
  });

  it("skips a deauthorized bank below the floor", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { holding: 0n, authorized: false }), bank(BANK_2)] });
    for (const p of planMany(issue, world)) expect(p?.bank).not.toBe(BANK_1);
  });

  it("applies rarely, with a small amount that stays under the ceiling, when no bank is low", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { holding: CEILING - 5n * USD }), bank(BANK_2, { holding: CEILING })] });
    const plans = planMany(issue, world, 1000).filter((p) => p !== undefined);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.length).toBeLessThan(150);
    for (const p of plans) {
      expect(p.bank).toBe(BANK_1);
      expect(p.amount).toBe(5n * USD);
    }
  });

  it("doesn't apply when every bank is at the ceiling", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { holding: CEILING }), bank(BANK_2, { holding: CEILING + 1n })] });
    expect(planMany(issue, world).every((p) => p === undefined)).toBe(true);
  });

  it("runs tokenAdmin.issue, touches the bank and describes the amount", async () => {
    const actors = fakeActors();
    const p = { bank: BANK_2, label: "Bank 2", amount: 250n * USD };
    await issue.run(actors, CB, p);
    expect(actors.calls).toEqual([{ as: "token-admin", method: "issue", args: [BANK_2, 250n * USD] }]);
    expect(issue.touches(CB, p)).toEqual([BANK_2]);
    expect(issue.describe(p)).toBe("250 to Bank 2");
  });
});

describe("clawback", () => {
  const clawback = action<TokenAmountParams>(createTokenActions(), "clawback");

  it("takes a slice from a bank above the ceiling that leaves it at or above the ceiling", () => {
    const holding = CEILING + 300n * USD;
    const world = fakeWorld({ banks: [bank(BANK_1), bank(BANK_2, { holding })] });
    for (const p of planMany(clawback, world)) {
      expect(p?.bank).toBe(BANK_2);
      expect(p!.amount > 0n).toBe(true);
      expect(holding - p!.amount >= CEILING).toBe(true);
    }
  });

  it("takes the single stroop from a bank one stroop above the ceiling", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { holding: CEILING + 1n })] });
    expect(clawback.plan(ctx(world))).toEqual({ bank: BANK_1, label: "Bank 1", amount: 1n });
  });

  it("doesn't apply at the ceiling", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { holding: CEILING }), bank(BANK_2)] });
    expect(clawback.plan(ctx(world))).toBeUndefined();
  });

  it("runs tokenAdmin.clawback and touches the bank", async () => {
    const actors = fakeActors();
    const p = { bank: BANK_3, label: "Bank 3", amount: 12_345_000n };
    await clawback.run(actors, CB, p);
    expect(actors.calls).toEqual([{ as: "token-admin", method: "clawback", args: [BANK_3, 12_345_000n] }]);
    expect(clawback.touches(CB, p)).toEqual([BANK_3]);
    expect(clawback.describe(p)).toBe("1.2345 from Bank 3");
  });
});

describe("deauthorize and reauthorize", () => {
  function setup() {
    const m = createTokenActions();
    return {
      deauthorize: action<DeauthorizeParams>(m, "deauthorize"),
      reauthorize: action<ReauthorizeParams>(m, "reauthorize"),
      world: fakeWorld(),
      actors: fakeActors(),
    };
  }

  it("deauthorizes one bank, stamped with the ledger time", async () => {
    const { deauthorize, world, actors } = setup();
    const p = deauthorize.plan(ctx(world))!;
    expect([BANK_1, BANK_2, BANK_3]).toContain(p.bank);
    expect(p.at).toBe(1_000);
    await deauthorize.run(actors, CB, p);
    expect(actors.calls).toEqual([{ as: "token-admin", method: "authorize", args: [p.bank, false] }]);
    expect(deauthorize.touches(CB, p)).toEqual([p.bank]);
  });

  it("deauthorizes at most one bank at a time", () => {
    const { deauthorize, world } = setup();
    world.state.banks[1]!.authorized = false;
    expect(planMany(deauthorize, world).every((p) => p === undefined)).toBe(true);
  });

  it("reauthorizes only once deauthorizeSecs have passed since its own deauthorization", async () => {
    const { deauthorize, reauthorize, world, actors } = setup();
    const p = deauthorize.plan(ctx(world))!;
    await deauthorize.run(actors, CB, p);
    world.state.banks.find((b) => b.address === p.bank)!.authorized = false;

    world.state.now = 1_000 + TUNING.deauthorizeSecs - 1;
    expect(reauthorize.plan(ctx(world))).toBeUndefined();

    world.state.now = 1_000 + TUNING.deauthorizeSecs;
    const r = reauthorize.plan(ctx(world))!;
    expect(r.bank).toBe(p.bank);
    await reauthorize.run(actors, CB, r);
    expect(actors.calls.at(-1)).toEqual({ as: "token-admin", method: "authorize", args: [p.bank, true] });
    expect(reauthorize.touches(CB, r)).toEqual([p.bank]);
  });

  it("forgets the record once reauthorized, so a later deauthorization waits again", async () => {
    const { deauthorize, reauthorize, world, actors } = setup();
    world.state.banks = [bank(BANK_1)];
    await deauthorize.run(actors, CB, deauthorize.plan(ctx(world))!);
    world.state.banks[0]!.authorized = false;
    world.state.now += TUNING.deauthorizeSecs;
    await reauthorize.run(actors, CB, reauthorize.plan(ctx(world))!);
    world.state.banks[0]!.authorized = true;

    await deauthorize.run(actors, CB, deauthorize.plan(ctx(world))!);
    world.state.banks[0]!.authorized = false;
    expect(reauthorize.plan(ctx(world))).toBeUndefined();
  });

  it("counts its own record as locked when the world's read is stale", async () => {
    const { deauthorize, reauthorize, world, actors } = setup();
    world.state.banks = [bank(BANK_1), bank(BANK_2)];
    const p = deauthorize.plan(ctx(world))!;
    await deauthorize.run(actors, CB, p);
    // The refresh after the deauthorization failed: the world still says authorized.
    expect(planMany(deauthorize, world).every((q) => q === undefined)).toBe(true);
    expect(reauthorize.plan(ctx(world))).toBeUndefined();
    world.state.now += TUNING.deauthorizeSecs;
    expect(reauthorize.plan(ctx(world))).toEqual({ bank: p.bank, label: p.label });
  });

  it("doesn't deauthorize when there are no banks", () => {
    const { deauthorize, world } = setup();
    world.state.banks = [];
    expect(deauthorize.plan(ctx(world))).toBeUndefined();
  });

  it("reauthorizes at once a bank found deauthorized with no record", () => {
    const { reauthorize, world } = setup();
    world.state.banks[2]!.authorized = false;
    expect(reauthorize.plan(ctx(world))).toEqual({ bank: BANK_3, label: "Bank 3" });
  });

  it("doesn't reauthorize when every bank is authorized", () => {
    const { reauthorize, world } = setup();
    expect(reauthorize.plan(ctx(world))).toBeUndefined();
  });

  it("describes the trustline", () => {
    const { deauthorize, reauthorize } = setup();
    expect(deauthorize.describe({ bank: BANK_1, label: "Bank 1", at: 0 })).toBe("Bank 1's trustline");
    expect(reauthorize.describe({ bank: BANK_1, label: "Bank 1" })).toBe("Bank 1's trustline");
  });

  it("records nothing when the deauthorization fails", async () => {
    const { deauthorize, reauthorize, world } = setup();
    const failing = fakeActors(() => {
      throw new Error("refused");
    });
    world.state.banks = [bank(BANK_1)];
    await expect(deauthorize.run(failing, CB, deauthorize.plan(ctx(world))!)).rejects.toThrow("refused");
    // Deauthorized by some other means: with no record, it's due at once.
    world.state.banks[0]!.authorized = false;
    expect(reauthorize.plan(ctx(world))).toEqual({ bank: BANK_1, label: "Bank 1" });
  });
});

describe("recover", () => {
  it("reauthorizes exactly the deauthorized banks, then refreshes them", async () => {
    const m = createTokenActions();
    const world = fakeWorld({ banks: [bank(BANK_1, { authorized: false }), bank(BANK_2), bank(BANK_3, { authorized: false })] });
    const actors = fakeActors();
    await m.recover!(actors, world);
    expect(actors.calls).toEqual([
      { as: "token-admin", method: "authorize", args: [BANK_1, true] },
      { as: "token-admin", method: "authorize", args: [BANK_3, true] },
    ]);
    expect(world.refreshed).toEqual([[BANK_1, BANK_3]]);
  });

  it("does nothing when every bank is authorized", async () => {
    const m = createTokenActions();
    const world = fakeWorld();
    const actors = fakeActors();
    await m.recover!(actors, world);
    expect(actors.calls).toEqual([]);
    expect(world.refreshed).toEqual([]);
  });

  it("tries every bank and refreshes them before throwing the first failure", async () => {
    const m = createTokenActions();
    const world = fakeWorld({ banks: [bank(BANK_1, { authorized: false }), bank(BANK_2, { authorized: false })] });
    const actors = fakeActors((call) => {
      if (call.args[0] === BANK_1) throw new Error("bank 1 refused");
      return txOutcome(undefined);
    });
    await expect(m.recover!(actors, world)).rejects.toThrow("bank 1 refused");
    expect(actors.calls.map((c) => c.args[0])).toEqual([BANK_1, BANK_2]);
    expect(world.refreshed).toEqual([[BANK_1, BANK_2]]);
  });

  it("also reauthorizes a bank it recorded as deauthorized that the world still shows authorized", async () => {
    const m = createTokenActions();
    const deauthorize = action<DeauthorizeParams>(m, "deauthorize");
    const world = fakeWorld({ banks: [bank(BANK_1)] });
    const actors = fakeActors();
    await deauthorize.run(actors, CB, deauthorize.plan(ctx(world))!);
    await m.recover!(actors, world);
    expect(actors.calls.at(-1)).toEqual({ as: "token-admin", method: "authorize", args: [BANK_1, true] });
    expect(world.refreshed).toEqual([[BANK_1]]);
    // The record is cleared, so deauthorize applies again.
    expect(deauthorize.plan(ctx(world))).toBeDefined();
  });

  it("throws the authorization's failure, not a later refresh failure", async () => {
    const m = createTokenActions();
    const world = fakeWorld({ banks: [bank(BANK_1, { authorized: false })] });
    world.refresh = async () => {
      throw new Error("refresh failed");
    };
    const actors = fakeActors(() => {
      throw new Error("authorize refused");
    });
    await expect(m.recover!(actors, world)).rejects.toThrow("authorize refused");
  });

  it("clears the record of a bank it reauthorizes", async () => {
    const m = createTokenActions();
    const deauthorize = action<DeauthorizeParams>(m, "deauthorize");
    const reauthorize = action<ReauthorizeParams>(m, "reauthorize");
    const world = fakeWorld({ banks: [bank(BANK_1)] });
    const actors = fakeActors();
    await deauthorize.run(actors, CB, deauthorize.plan(ctx(world))!);
    world.state.banks[0]!.authorized = false;
    await m.recover!(actors, world);
    // Found deauthorized again later with no record: due at once, not after deauthorizeSecs.
    expect(reauthorize.plan(ctx(world))).toEqual({ bank: BANK_1, label: "Bank 1" });
  });
});
