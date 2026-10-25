import type { Credit, Repo } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { BANK_1, BANK_2, BANK_3, CB, TUNING, USD, bank, fakeActors, fakeWorld, payment } from "../../test/fakes.ts";
import { createRng } from "../rng.ts";
import type { PlanContext, WorldView } from "../types.ts";
import { creditActions, openRepo, repay, repayOnBehalf, setCollateral } from "./credit.ts";

const credit = (over: Partial<Credit> = {}): Credit => ({ intraday: 0n, penalty: 0n, collateral: 0n, ...over });

let nextRepo = 0n;
const repo = (over: Partial<Repo> = {}): Repo => ({
  id: nextRepo++,
  bank: BANK_1,
  amount: 500n * USD,
  outstanding: 500n * USD,
  openedAt: 1_000,
  status: "intraday",
  rateBps: 0,
  ...over,
});

const ctx = (world: WorldView, actor = CB, seed = 1): PlanContext => ({ world, rng: createRng(seed), actor, tuning: TUNING });

/** Plans across many seeds, so a property holds whatever the RNG picks. */
const plans = <P>(plan: (c: PlanContext) => P | undefined, world: WorldView, actor = CB): (P | undefined)[] =>
  Array.from({ length: 200 }, (_, seed) => plan(ctx(world, actor, seed)));

describe("creditActions", () => {
  it("gates every action on its capability", () => {
    expect(creditActions.group).toBe("credit");
    expect(creditActions.actions.map((a) => [a.name, a.role, a.capability])).toEqual([
      ["setCollateral", "central-bank", "setCollateral"],
      ["openRepo", "central-bank", "openRepo"],
      ["repay", "bank", "repay"],
      ["repay", "central-bank", "repay"],
    ]);
    for (const a of creditActions.actions) expect(a.touches(CB, {})).toEqual([]);
  });
});

describe("setCollateral", () => {
  it("picks a value in tuning.collateral", () => {
    for (const p of plans(setCollateral.plan, fakeWorld())) {
      expect(p!.value >= TUNING.collateral.min && p!.value <= TUNING.collateral.max).toBe(true);
      expect(p!.label).toBe(`Bank ${p!.bank.slice(-1)}`);
    }
  });

  it("never goes below a bank's intraday credit", () => {
    const intraday = 4_000n * USD;
    const world = fakeWorld({ banks: [bank(BANK_1, { credit: credit({ intraday, collateral: intraday }) })] });
    for (const p of plans(setCollateral.plan, world)) expect(p!.value >= intraday).toBe(true);
  });

  it("allows a value equal to the intraday credit at the top of the range", () => {
    const intraday = TUNING.collateral.max;
    const world = fakeWorld({ banks: [bank(BANK_1, { credit: credit({ intraday, collateral: intraday }) })] });
    expect(setCollateral.plan(ctx(world))).toEqual({ bank: BANK_1, label: "Bank 1", value: intraday });
  });

  it("skips a bank whose intraday credit is above the range, and is undefined when none is left", () => {
    const over = credit({ intraday: TUNING.collateral.max + 1n, collateral: TUNING.collateral.max + 1n });
    const world = fakeWorld({ banks: [bank(BANK_1, { credit: over }), bank(BANK_2)] });
    for (const p of plans(setCollateral.plan, world)) expect(p!.bank).toBe(BANK_2);
    world.state.banks = [bank(BANK_1, { credit: over })];
    expect(setCollateral.plan(ctx(world))).toBeUndefined();
  });

  it("counts penalty credit with intraday credit as the floor", () => {
    const c = credit({ intraday: 2_000n * USD, penalty: 2_500n * USD, collateral: 4_500n * USD });
    const world = fakeWorld({ banks: [bank(BANK_1, { credit: c })] });
    for (const p of plans(setCollateral.plan, world)) expect(p!.value >= 4_500n * USD).toBe(true);
    // Intraday plus penalty just above the range: no value the contract would take.
    world.state.banks = [bank(BANK_1, { credit: { ...c, penalty: TUNING.collateral.max - 2_000n * USD + 1n } })];
    expect(setCollateral.plan(ctx(world))).toBeUndefined();
  });

  it("runs as the central bank", async () => {
    const actors = fakeActors();
    await setCollateral.run(actors, CB, { bank: BANK_2, label: "Bank 2", value: 7n * USD });
    expect(actors.calls).toEqual([{ as: CB, method: "setCollateral", args: [BANK_2, 7n * USD] }]);
    expect(setCollateral.describe({ bank: BANK_2, label: "Bank 2", value: 7n * USD })).toBe("Bank 2 collateral 7 USD");
  });
});

describe("openRepo", () => {
  it("is undefined with no headroom", () => {
    const world = fakeWorld({
      banks: [
        bank(BANK_1),
        bank(BANK_2, { credit: credit({ intraday: 1_000n * USD, collateral: 1_000n * USD }) }),
        bank(BANK_3, { credit: credit({ intraday: 0n, collateral: 0n }), collateral: 2_000n * USD }),
      ],
    });
    expect(openRepo.plan(ctx(world))).toBeUndefined();
  });

  it("stays within collateral less intraday credit", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { credit: credit({ intraday: 1_000n * USD, collateral: 1_100n * USD }) })] });
    for (const p of plans(openRepo.plan, world)) expect(p!.amount > 0n && p!.amount <= 100n * USD).toBe(true);
  });

  it("counts penalty credit against collateral", () => {
    const world = fakeWorld({
      banks: [bank(BANK_1, { credit: credit({ intraday: 600n * USD, penalty: 400n * USD, collateral: 1_000n * USD }) })],
    });
    expect(openRepo.plan(ctx(world))).toBeUndefined();
    world.state.banks = [bank(BANK_1, { credit: credit({ intraday: 600n * USD, penalty: 370n * USD, collateral: 1_000n * USD }) })];
    for (const p of plans(openRepo.plan, world)) expect(p!.amount > 0n && p!.amount <= 30n * USD).toBe(true);
  });

  it("falls back to collateral from CollateralSet events while credit is a stub", () => {
    const world = fakeWorld({ banks: [bank(BANK_1), bank(BANK_2, { collateral: 2_000n * USD })] });
    for (const p of plans(openRepo.plan, world)) {
      expect(p!.bank).toBe(BANK_2);
      expect(p!.amount >= TUNING.paymentSize.min && p!.amount <= TUNING.paymentSize.max).toBe(true);
    }
  });

  it("prefers a bank whose balance doesn't cover its queue, aiming at the shortfall", () => {
    const coll = credit({ collateral: 5_000n * USD });
    const world = fakeWorld({
      banks: [
        bank(BANK_1, { credit: coll }),
        bank(BANK_2, {
          credit: coll,
          balance: 100n * USD,
          queues: { urgent: [payment({ from: BANK_2, amount: 250n * USD })], normal: [payment({ from: BANK_2, amount: 50n * USD })] },
        }),
        bank(BANK_3, { credit: coll, queues: { urgent: [], normal: [payment({ from: BANK_3, amount: 10n * USD })] } }),
      ],
    });
    for (const p of plans(openRepo.plan, world)) expect(p).toEqual({ bank: BANK_2, label: "Bank 2", amount: 200n * USD });
  });

  it("caps the shortfall at the headroom", () => {
    const world = fakeWorld({
      banks: [
        bank(BANK_1, {
          credit: credit({ intraday: 950n * USD, collateral: 1_000n * USD }),
          balance: 0n,
          queues: { urgent: [payment({ amount: 300n * USD })], normal: [] },
        }),
      ],
    });
    expect(openRepo.plan(ctx(world))!.amount).toBe(50n * USD);
  });

  it("runs as the central bank", async () => {
    const actors = fakeActors();
    await openRepo.run(actors, CB, { bank: BANK_1, label: "Bank 1", amount: 3n * USD });
    expect(actors.calls).toEqual([{ as: CB, method: "openRepo", args: [BANK_1, 3n * USD] }]);
    expect(openRepo.describe({ bank: BANK_1, label: "Bank 1", amount: 3n * USD })).toBe("3 USD to Bank 1");
  });
});

describe("repay", () => {
  it("is undefined when the bank has no repos", () => {
    const world = fakeWorld({ repos: [repo({ bank: BANK_2 }), repo({ bank: BANK_1, outstanding: 0n, status: "repaid" })] });
    expect(repay.plan(ctx(world, BANK_1))).toBeUndefined();
  });

  it("is undefined with a zero balance", () => {
    const world = fakeWorld({ banks: [bank(BANK_1, { balance: 0n })], repos: [repo()] });
    expect(repay.plan(ctx(world, BANK_1))).toBeUndefined();
  });

  it("repays its own repo, up to the outstanding amount and the balance", () => {
    const world = fakeWorld({
      banks: [bank(BANK_1, { balance: 200n * USD }), bank(BANK_2)],
      repos: [repo({ bank: BANK_2 }), repo({ id: 900n, outstanding: 300n * USD, status: "penalty", rateBps: 500 })],
    });
    for (const p of plans(repay.plan, world, BANK_1)) {
      expect(p!.repoId).toBe(900n);
      expect(p!.bank).toBe(BANK_1);
      expect(p!.amount > 0n && p!.amount <= 200n * USD).toBe(true);
    }
  });

  it("sometimes repays the whole outstanding amount", () => {
    const world = fakeWorld({ repos: [repo({ outstanding: 400n * USD })] });
    const amounts = plans(repay.plan, world, BANK_1).map((p) => p!.amount);
    expect(amounts.every((a) => a > 0n && a <= 400n * USD)).toBe(true);
    expect(amounts).toContain(400n * USD);
    expect(amounts.some((a) => a < 400n * USD)).toBe(true);
  });

  it("runs as the bank", async () => {
    const actors = fakeActors();
    await repay.run(actors, BANK_1, { bank: BANK_1, label: "Bank 1", repoId: 4n, amount: 5n * USD });
    expect(actors.calls).toEqual([{ as: BANK_1, method: "repay", args: [4n, 5n * USD] }]);
    expect(repay.describe({ bank: BANK_1, label: "Bank 1", repoId: 4n, amount: 5n * USD })).toBe("5 USD of repo #4");
  });
});

describe("repay on a bank's behalf", () => {
  it("picks any bank's repo its balance can pay towards", () => {
    const world = fakeWorld({
      banks: [bank(BANK_1, { balance: 0n }), bank(BANK_2), bank(BANK_3)],
      repos: [repo({ bank: BANK_1 }), repo({ id: 901n, bank: BANK_3 })],
    });
    for (const p of plans(repayOnBehalf.plan, world)) {
      expect(p!.repoId).toBe(901n);
      expect(p!.label).toBe("Bank 3");
    }
    world.state.repos = [repo({ bank: BANK_1 })];
    expect(repayOnBehalf.plan(ctx(world))).toBeUndefined();
  });

  it("runs as the central bank", async () => {
    const actors = fakeActors();
    const p = { bank: BANK_2, label: "Bank 2", repoId: 6n, amount: 8n * USD };
    await repayOnBehalf.run(actors, CB, p);
    expect(actors.calls).toEqual([{ as: CB, method: "repay", args: [6n, 8n * USD] }]);
    expect(repayOnBehalf.describe(p)).toBe("8 USD of repo #6 for Bank 2");
  });
});
