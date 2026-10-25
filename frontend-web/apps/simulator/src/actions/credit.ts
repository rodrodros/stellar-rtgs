// Credit operations, while the deployed contract implements them: set_collateral, open_repo,
// repay. Each plan keeps within the contract's limits (collateral never below intraday credit,
// credit never above collateral, a repayment never above what is outstanding or what the
// bank's settlement balance covers), so a refusal means a race, not a bad plan.
// No trustline cash moves: open_repo mints into the contract and repay burns from it.
import { CASH_CODE, formatAmount } from "@rtgs/core";
import type { Repo } from "@rtgs/core";
import type { ActionDef, ActionModule, BankState, PlanContext } from "../types.ts";

export interface SetCollateralParams {
  bank: string;
  label: string;
  value: bigint;
}

export interface OpenRepoParams {
  bank: string;
  label: string;
  amount: bigint;
}

export interface RepayParams {
  /** The repo's bank. */
  bank: string;
  label: string;
  repoId: bigint;
  amount: bigint;
}

const cash = (amount: bigint) => `${formatAmount(amount)} ${CASH_CODE}`;

/** Intraday credit outstanding; zero while the world's `credit` is a stub. */
function intraday(b: BankState): bigint {
  return b.credit?.intraday ?? 0n;
}

/** The contract's collateral value, else the last `CollateralSet` seen, else none. */
function collateral(b: BankState): bigint {
  return b.credit?.collateral ?? b.collateral ?? 0n;
}

/** What the bank's queued orders need beyond its settlement balance; zero if it covers them. */
function shortfall(b: BankState): bigint {
  const queued = [...b.queues.urgent, ...b.queues.normal].reduce((sum, p) => sum + p.amount, 0n);
  return queued > b.balance ? queued - b.balance : 0n;
}

/** Central bank: a new collateral value for a bank, uniform in `tuning.collateral` and never below its intraday credit. */
export const setCollateral: ActionDef<SetCollateralParams> = {
  name: "setCollateral",
  group: "credit",
  role: "central-bank",
  capability: "setCollateral",
  plan({ world, rng, tuning }) {
    const { min, max } = tuning.collateral;
    const banks = world.banks().filter((b) => intraday(b) <= max);
    if (banks.length === 0) return undefined;
    const b = rng.pick(banks);
    const floor = intraday(b) > min ? intraday(b) : min;
    return { bank: b.address, label: b.label, value: rng.bigint(floor, max) };
  },
  run: (actors, _actor, p) => actors.centralBank.setCollateral(p.bank, p.value),
  describe: (p) => `${p.label} collateral ${cash(p.value)}`,
  touches: () => [],
};

/**
 * Central bank: an intraday repo within the bank's headroom (collateral less intraday credit).
 * Banks whose balance doesn't cover their queue come first: the repo's cash releases their
 * orders through the eager closure, so the amount aims at that shortfall.
 */
export const openRepo: ActionDef<OpenRepoParams> = {
  name: "openRepo",
  group: "credit",
  role: "central-bank",
  capability: "openRepo",
  plan({ world, rng, tuning }) {
    const headroom = (b: BankState) => collateral(b) - intraday(b);
    const open = world.banks().filter((b) => headroom(b) > 0n);
    if (open.length === 0) return undefined;
    const stuck = open.filter((b) => shortfall(b) > 0n);
    const b = rng.pick(stuck.length > 0 ? stuck : open);
    const room = headroom(b);
    const need = shortfall(b);
    let amount: bigint;
    if (need > 0n) {
      amount = need < room ? need : room;
    } else {
      const cap = tuning.paymentSize.max < room ? tuning.paymentSize.max : room;
      amount = rng.bigint(tuning.paymentSize.min < cap ? tuning.paymentSize.min : cap, cap);
    }
    return { bank: b.address, label: b.label, amount };
  },
  run: (actors, _actor, p) => actors.centralBank.openRepo(p.bank, p.amount),
  describe: (p) => `${cash(p.amount)} to ${p.label}`,
  touches: () => [],
};

/**
 * A repayment of one of `repos`, up to what is outstanding and what the bank's settlement
 * balance covers. Half the time it can, it repays the whole repo, so repos reach `repaid`.
 */
function planRepay({ world, rng, tuning }: PlanContext, repos: readonly Repo[]): RepayParams | undefined {
  const payable = repos.filter((r) => r.outstanding > 0n && (world.bank(r.bank)?.balance ?? 0n) > 0n);
  if (payable.length === 0) return undefined;
  const repo = rng.pick(payable);
  const b = world.bank(repo.bank)!;
  const cap = repo.outstanding < b.balance ? repo.outstanding : b.balance;
  const amount =
    cap === repo.outstanding && rng.chance(0.5)
      ? cap
      : rng.bigint(tuning.paymentSize.min < cap ? tuning.paymentSize.min : cap, cap);
  return { bank: b.address, label: b.label, repoId: repo.id, amount };
}

/** A bank repays one of its own repos, intraday or penalty. */
export const repay: ActionDef<RepayParams> = {
  name: "repay",
  group: "credit",
  role: "bank",
  capability: "repay",
  plan: (ctx) => planRepay(ctx, ctx.world.repos(ctx.actor)),
  run: (actors, actor, p) => actors.bank(actor).repay(p.repoId, p.amount),
  describe: (p) => `${cash(p.amount)} of repo #${p.repoId}`,
  touches: () => [],
};

/** The central bank repays any bank's repo on its behalf, from that bank's settlement balance. */
export const repayOnBehalf: ActionDef<RepayParams> = {
  name: "repay",
  group: "credit",
  role: "central-bank",
  capability: "repay",
  plan: (ctx) => planRepay(ctx, ctx.world.repos()),
  run: (actors, _actor, p) => actors.centralBank.repay(p.repoId, p.amount),
  describe: (p) => `${cash(p.amount)} of repo #${p.repoId} for ${p.label}`,
  touches: () => [],
};

export const creditActions: ActionModule = { group: "credit", actions: [setCollateral, openRepo, repay, repayOnBehalf] };
