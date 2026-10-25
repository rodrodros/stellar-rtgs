import { describe, expect, it } from "vitest";
import { allAvailable } from "@rtgs/core";
import { BANK_1, BANK_2, BANK_3, CB, CONFIG, USD, fakeActors, fakeWorld, txOutcome } from "../../test/fakes.ts";
import { createRng } from "../rng.ts";
import type { ActionDef, ActionModule, ActionName, ExclusionKey, PlanContext, Role } from "../types.ts";
import { PROFILES, createPolicy, defaultTuning } from "./index.ts";

/** An action whose plan applies when `applies(ctx)` says so, recording the contexts it saw. */
function action(name: ActionName, role: Role, over: Partial<ActionDef<string>> & { applies?: (ctx: PlanContext) => boolean } = {}) {
  const planned: PlanContext[] = [];
  const { applies = () => true, ...rest } = over;
  const def: ActionDef<string> & { planned: PlanContext[] } = {
    name,
    group: "payments",
    role,
    plan: (ctx) => {
      planned.push(ctx);
      return applies(ctx) ? `${name} by ${ctx.actor}` : undefined;
    },
    run: async () => txOutcome(undefined),
    describe: (p) => p,
    touches: (actor) => [actor],
    planned,
    ...rest,
  };
  return def;
}

const module = (...actions: ActionDef<any>[]): ActionModule => ({ group: "payments", actions });
const names = (choices: { action: ActionDef<any> }[]) => choices.map((c) => c.action.name);

describe("createPolicy", () => {
  it("chooses only actions whose capability is available or absent", () => {
    const world = fakeWorld({ capabilities: { ...allAvailable(), openRepo: "stub", setCollateral: "unknown" } });
    const policy = createPolicy({
      profile: "balanced",
      modules: [
        module(
          action("openRepo", "central-bank", { capability: "openRepo" }),
          action("setCollateral", "central-bank", { capability: "setCollateral" }),
          action("issue", "central-bank"),
        ),
      ],
      rng: createRng(1),
    });
    for (let i = 0; i < 50; i++) expect(names(policy.choose(world, [CB]))).toEqual(["issue"]);
  });

  it("logs the actions disabled by capabilities once per run", () => {
    const world = fakeWorld({ capabilities: { ...allAvailable(), openRepo: "stub", repay: "stub" } });
    const lines: string[] = [];
    const policy = createPolicy({
      profile: "balanced",
      modules: [
        module(
          action("openRepo", "central-bank", { capability: "openRepo" }),
          action("repay", "central-bank", { capability: "repay" }),
          action("repay", "bank", { capability: "repay" }),
          action("issue", "central-bank"),
        ),
      ],
      rng: createRng(1),
      log: (m) => lines.push(m),
    });
    policy.choose(world, [CB]);
    policy.choose(world, [CB, BANK_1]);
    expect(lines).toEqual(["Disabled by capabilities: openRepo (openRepo: stub), repay (repay: stub)"]);
  });

  it("logs nothing when every action is available", () => {
    const lines: string[] = [];
    const policy = createPolicy({ profile: "balanced", modules: [module(action("submit", "bank"))], rng: createRng(1), log: (m) => lines.push(m) });
    policy.choose(fakeWorld(), [BANK_1]);
    expect(lines).toEqual([]);
  });

  it("splits actions by role: the central bank's lane gets its actions, banks get theirs", () => {
    const policy = createPolicy({
      profile: "balanced",
      modules: [module(action("submit", "bank"), action("deposit", "bank"), action("issue", "central-bank"), action("openRepo", "central-bank"))],
      rng: createRng(3),
    });
    for (let i = 0; i < 100; i++) {
      for (const c of policy.choose(fakeWorld(), [BANK_1, CB, BANK_2])) {
        expect(["submit", "deposit"].includes(c.action.name)).toBe(c.actor !== CB);
        expect(c.action.role).toBe(c.actor === CB ? "central-bank" : "bank");
      }
    }
  });

  it("gives at most one choice per idle actor, with the plan's params", () => {
    const policy = createPolicy({ profile: "balanced", modules: [module(action("submit", "bank"), action("issue", "central-bank"))], rng: createRng(1) });
    const choices = policy.choose(fakeWorld(), [BANK_1, BANK_2, CB]);
    expect(choices.map((c) => [c.actor, c.params])).toEqual([
      [BANK_1, `submit by ${BANK_1}`],
      [BANK_2, `submit by ${BANK_2}`],
      [CB, `issue by ${CB}`],
    ]);
  });

  it("never chooses an excluded pair", () => {
    const policy = createPolicy({ profile: "balanced", modules: [module(action("submit", "bank"), action("revoke", "bank"))], rng: createRng(5) });
    const excluded = new Set<ExclusionKey>([`submit:${BANK_1}`, `revoke:${BANK_2}`]);
    for (let i = 0; i < 100; i++) {
      for (const c of policy.choose(fakeWorld(), [BANK_1, BANK_2], excluded)) {
        expect(excluded.has(`${c.action.name}:${c.actor}`)).toBe(false);
      }
    }
    const both = new Set<ExclusionKey>([`submit:${BANK_3}`, `revoke:${BANK_3}`]);
    expect(policy.choose(fakeWorld(), [BANK_3], both)).toEqual([]);
  });

  it("falls through to the next action when plan doesn't apply, trying each once", () => {
    const submit = action("submit", "bank", { applies: () => false });
    const revoke = action("revoke", "bank", { applies: () => false });
    const deposit = action("deposit", "bank");
    const policy = createPolicy({ profile: "balanced", modules: [module(submit, revoke, deposit)], rng: createRng(9) });
    for (let i = 0; i < 20; i++) expect(names(policy.choose(fakeWorld(), [BANK_1]))).toEqual(["deposit"]);
    expect(submit.planned.length).toBeLessThanOrEqual(20);
    expect(submit.planned.length).toBeGreaterThan(0);
  });

  it("leaves out an actor with nothing to do", () => {
    const submit = action("submit", "bank", { applies: (ctx) => ctx.actor !== BANK_2 });
    const policy = createPolicy({ profile: "balanced", modules: [module(submit)], rng: createRng(1) });
    expect(policy.choose(fakeWorld(), [BANK_1, BANK_2, CB]).map((c) => c.actor)).toEqual([BANK_1]);
    // Each action was planned at most once per actor.
    expect(submit.planned.map((c) => c.actor)).toEqual([BANK_1, BANK_2]);
  });

  it("never chooses an action the profile doesn't weigh", () => {
    const policy = createPolicy({ profile: "calm", modules: [module(action("revoke", "bank"), action("withdraw", "bank"))], rng: createRng(1) });
    for (let i = 0; i < 50; i++) expect(names(policy.choose(fakeWorld(), [BANK_1]))).toEqual(["withdraw"]);
  });

  it("roughly respects the profile's weights over many draws", () => {
    const actions = (["submit", "deposit", "withdraw", "revoke"] as const).map((n) => action(n, "bank"));
    const policy = createPolicy({ profile: "balanced", modules: [module(...actions)], rng: createRng(2024) });
    const counts: Record<string, number> = {};
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      for (const c of policy.choose(fakeWorld(), [BANK_1])) counts[c.action.name] = (counts[c.action.name] ?? 0) + 1;
    }
    const w = PROFILES.balanced.weights;
    const total = w.submit! + w.deposit! + w.withdraw! + w.revoke!;
    for (const a of actions) {
      expect(counts[a.name]! / draws).toBeCloseTo(w[a.name]! / total, 1);
    }
  });

  it("is repeatable for the same rng seed", () => {
    const run = () => {
      const policy = createPolicy({
        profile: "gridlock",
        modules: [module(action("submit", "bank"), action("deposit", "bank"), action("openRepo", "central-bank"), action("issue", "central-bank"))],
        rng: createRng(77),
      });
      return Array.from({ length: 30 }, () => names(policy.choose(fakeWorld(), [BANK_1, BANK_2, CB])));
    };
    expect(run()).toEqual(run());
  });

  it("plans with the default tuning, the profile's submit mix and the overrides", () => {
    const submit = action("submit", "bank");
    const policy = createPolicy({ profile: "gridlock", modules: [module(submit)], rng: createRng(1), tuning: { deauthorizeSecs: 5 } });
    policy.choose(fakeWorld(), [BANK_1]);
    expect(submit.planned[0]!.tuning).toEqual({ ...defaultTuning(CONFIG, 3), submitMix: PROFILES.gridlock.submitMix, deauthorizeSecs: 5 });
  });

  it("plans actions that a real run could perform", async () => {
    // A choice carries the def and params the engine runs.
    const policy = createPolicy({ profile: "balanced", modules: [module(action("submit", "bank"))], rng: createRng(1) });
    const [choice] = policy.choose(fakeWorld(), [BANK_1]);
    await expect(choice!.action.run(fakeActors(), choice!.actor, choice!.params)).resolves.toBeDefined();
  });
});

describe("defaultTuning", () => {
  it("sizes amounts against the bootstrap's 10,000 USD per bank", () => {
    expect(defaultTuning(CONFIG, 3)).toEqual({
      paymentSize: { min: 10n * USD, max: 800n * USD },
      queueHeadroom: 2,
      holdingFloor: 1_000n * USD,
      holdingCeiling: 15_000n * USD,
      deauthorizeSecs: 20,
      collateral: { min: 1_000n * USD, max: 5_000n * USD },
      submitMix: { covered: 6, uncovered: 3, gridlock: 1 },
    });
  });

  it("leaves a queue slot per other bank lane, within the queue cap", () => {
    expect(defaultTuning(CONFIG, 6).queueHeadroom).toBe(5);
    expect(defaultTuning({ ...CONFIG, queueCap: 4 }, 6).queueHeadroom).toBe(3);
    expect(defaultTuning({ ...CONFIG, queueCap: 1 }, 3).queueHeadroom).toBe(1);
  });
});

describe("PROFILES", () => {
  it("keeps calm to covered payments, deposits, withdrawals and top-ups", () => {
    expect(Object.keys(PROFILES.calm.weights).sort()).toEqual(["deposit", "issue", "submit", "withdraw"]);
    expect(PROFILES.calm.submitMix).toEqual({ covered: 1, uncovered: 0, gridlock: 0 });
  });

  it("leans gridlock towards queueing and crossing submits", () => {
    const { covered, uncovered, gridlock } = PROFILES.gridlock.submitMix;
    expect(uncovered + gridlock).toBeGreaterThan(covered * 4);
    expect(PROFILES.gridlock.weights.clawback ?? 0).toBe(0);
    expect(PROFILES.gridlock.weights.deauthorize ?? 0).toBe(0);
  });
});
