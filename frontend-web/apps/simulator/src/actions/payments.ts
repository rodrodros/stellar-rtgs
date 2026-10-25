// Bank payment operations: deposit, withdraw, submit, revoke, reprioritise. Ticket 03.
//
// Each `plan` reads the latest snapshot and returns undefined wherever the contract would
// refuse (Flow 22's rules, in the spec), so a refusal that still happens is a race with
// another lane or with the eager closure. Amounts come from the policy's `Tuning`.
import { CASH_CODE, formatAmount } from "@rtgs/core";
import type { Payment, Priority } from "@rtgs/core";
import type { ActionDef, ActionModule, BankState, PlanContext, Rng, Tuning, WorldView } from "../types.ts";

/** How often a submitted payment order is urgent. */
const URGENT_SHARE = 0.25;

export interface DepositParams {
  amount: bigint;
  /** Sized to cover the bank's queue heads, so the eager closure releases them. */
  releases: boolean;
}

export interface WithdrawParams {
  amount: bigint;
}

/**
 * The three shapes of `submit` (`Tuning.submitMix`): `covered` settles at once, `uncovered`
 * queues, and `gridlock` crosses a payment order the payee has queued back, so the offset
 * settles both.
 */
export type SubmitShape = "covered" | "uncovered" | "gridlock";

export interface SubmitParams {
  to: string;
  /** The payee's label, for `describe`. */
  toLabel: string;
  amount: bigint;
  priority: Priority;
  /** What the plan intended; the outcome says what happened. */
  shape: SubmitShape;
  /** For `gridlock`: the payee's queued payment order this one crosses. */
  crosses?: bigint;
}

/** A queued payment order of the actor's, as `revoke` and `reprioritise` name it. */
export interface QueuedParams {
  id: bigint;
  amount: bigint;
  toLabel: string;
}

export interface ReprioritiseParams extends QueuedParams {
  /** The class it moves to: the other one. */
  priority: Priority;
}

export const deposit: ActionDef<DepositParams> = {
  name: "deposit",
  group: "payments",
  role: "bank",
  capability: "deposit",
  plan({ world, rng, actor, tuning }) {
    const me = world.bank(actor);
    if (!me?.authorized || me.holding <= 0n) return undefined;
    // Leave half the floor in the trustline when the holding allows it.
    const keep = tuning.holdingFloor / 2n;
    const cap = me.holding > keep ? me.holding - keep : me.holding;
    const shortfall = headsSum(me) - me.balance;
    const releases = shortfall > 0n;
    // Releasing the queue may dip into the reserve: that is what the deposit is for.
    const lo = releases ? min(shortfall, me.holding) : max(1n, min(tuning.paymentSize.min, cap));
    return { amount: rng.bigint(lo, max(lo, cap)), releases };
  },
  run: (actors, actor, p) => actors.bank(actor).deposit(p.amount),
  describe: (p) => `${usd(p.amount)}${p.releases ? ", to release its queue" : ""}`,
  touches: (actor) => [actor],
};

export const withdraw: ActionDef<WithdrawParams> = {
  name: "withdraw",
  group: "payments",
  role: "bank",
  capability: "withdraw",
  plan({ world, rng, actor, tuning }) {
    const me = world.bank(actor);
    if (!me?.authorized || me.balance <= 0n) return undefined;
    // Keep what the queue heads need; failing that, take a tenth at most.
    const free = me.balance - headsSum(me);
    const hi = free > 0n ? max(1n, free / 2n) : max(1n, me.balance / 10n);
    return { amount: rng.bigint(max(1n, min(tuning.paymentSize.min, hi)), hi) };
  },
  run: (actors, actor, p) => actors.bank(actor).withdraw(p.amount),
  describe: (p) => usd(p.amount),
  touches: (actor) => [actor],
};

export const submit: ActionDef<SubmitParams> = {
  name: "submit",
  group: "payments",
  role: "bank",
  capability: "submit",
  plan(ctx) {
    const me = ctx.world.bank(ctx.actor);
    if (!me || !ctx.world.banks().some((b) => b.address !== ctx.actor)) return undefined;
    // A shape that doesn't apply falls back to covered; covered that doesn't (no balance, or
    // something queued ahead) to uncovered, which is what the contract would make of it.
    const shape = pickShape(ctx);
    return (
      (shape === "gridlock" ? planGridlock(ctx, me) : undefined) ??
      (shape === "uncovered" ? planUncovered(ctx, me) : undefined) ??
      planCovered(ctx, me) ??
      planUncovered(ctx, me)
    );
  },
  run: (actors, actor, p) => actors.bank(actor).submit({ to: p.to, amount: p.amount, priority: p.priority }),
  describe: (p) =>
    `${usd(p.amount)} to ${p.toLabel} (${p.priority}, ${p.shape}${p.crosses === undefined ? "" : ` against #${p.crosses}`})`,
  touches: () => [],
};

export const revoke: ActionDef<QueuedParams> = {
  name: "revoke",
  group: "payments",
  role: "bank",
  capability: "revoke",
  plan({ world, rng, actor }) {
    const queued = world.queuedPayments(actor);
    if (queued.length === 0) return undefined;
    return queuedParams(world, rng.pick(queued));
  },
  run: (actors, actor, p) => actors.bank(actor).revoke(p.id),
  describe: (p) => describeQueued(p),
  touches: () => [],
};

export const reprioritise: ActionDef<ReprioritiseParams> = {
  name: "reprioritise",
  group: "payments",
  role: "bank",
  capability: "reprioritise",
  plan({ world, rng, actor }) {
    const queued = world.queuedPayments(actor);
    if (queued.length === 0) return undefined;
    const p = rng.pick(queued);
    return { ...queuedParams(world, p), priority: p.priority === "urgent" ? "normal" : "urgent" };
  },
  run: (actors, actor, p) => actors.bank(actor).reprioritise(p.id, p.priority),
  describe: (p) => `${describeQueued(p)}, to ${p.priority}`,
  touches: () => [],
};

export const paymentActions: ActionModule = {
  group: "payments",
  actions: [deposit, withdraw, submit, revoke, reprioritise],
};

/** Settles at once: the balance covers it, and nothing of the sender's is queued ahead (S7). */
function planCovered({ world, rng, actor, tuning }: PlanContext, me: BankState): SubmitParams | undefined {
  if (me.balance <= 0n || me.queues.urgent.length > 0) return undefined;
  // With normal payment orders queued, only an urgent one has nothing ahead of it.
  const priority = me.queues.normal.length > 0 ? "urgent" : pickPriority(rng);
  const hi = min(tuning.paymentSize.max, me.balance);
  const amount = rng.bigint(max(1n, min(tuning.paymentSize.min, hi)), hi);
  return { ...payee(world, rng, actor), amount, priority, shape: "covered" };
}

/** Queues: more than the balance, while the central queue has headroom. */
function planUncovered({ world, rng, actor, tuning }: PlanContext, me: BankState): SubmitParams | undefined {
  if (!hasHeadroom(world, tuning)) return undefined;
  const amount = rng.bigint(me.balance + 1n, me.balance + max(1n, tuning.paymentSize.max));
  return { ...payee(world, rng, actor), amount, priority: pickPriority(rng), shape: "uncovered" };
}

/**
 * Crosses a payee's queued payment order back to this bank. The offset settles a prefix of
 * each bank's queue in `≺` order (urgent first, then by id), so the payee's order must be
 * first in its queue and the new one first in ours. Then, with balances `a` (ours) and `b`
 * (the payee's) and the payee's order `x`, any amount `y` with `a < y ≤ a + x` and
 * `y ≥ x − b` queues and leaves both banks non-negative once the two net: the offset takes
 * them, whatever else is queued.
 */
function planGridlock({ world, rng, actor, tuning }: PlanContext, me: BankState): SubmitParams | undefined {
  if (!hasHeadroom(world, tuning) || me.queues.urgent.length > 0) return undefined;
  const crossing = world.banks().flatMap((b) => {
    const first = b.queues.urgent[0] ?? b.queues.normal[0];
    return b.address !== actor && first?.to === actor ? [{ bank: b, order: first }] : [];
  });
  if (crossing.length === 0) return undefined;
  const { bank, order } = rng.pick(crossing);
  const lo = max(me.balance + 1n, order.amount - bank.balance);
  const amount = rng.bigint(lo, me.balance + order.amount);
  // An urgent order goes ahead of our queued normal ones; with none queued, either class.
  const priority = me.queues.normal.length > 0 ? "urgent" : pickPriority(rng);
  return { to: bank.address, toLabel: bank.label, amount, priority, shape: "gridlock", crosses: order.id };
}

function pickShape({ rng, tuning }: PlanContext): SubmitShape {
  const mix = tuning.submitMix;
  const total = mix.covered + mix.uncovered + mix.gridlock;
  if (total <= 0) return "covered";
  const r = rng.next() * total;
  if (r < mix.covered) return "covered";
  return r < mix.covered + mix.uncovered ? "uncovered" : "gridlock";
}

/** `QueueFull` refuses an order still queued while `queuedCount ≥ queueCap`; keep clear of it. */
function hasHeadroom(world: WorldView, tuning: Tuning): boolean {
  return world.queuedCount() < world.config().queueCap - tuning.queueHeadroom;
}

function payee(world: WorldView, rng: Rng, actor: string): { to: string; toLabel: string } {
  const to = rng.pick(world.banks().filter((b) => b.address !== actor));
  return { to: to.address, toLabel: to.label };
}

function pickPriority(rng: Rng): Priority {
  return rng.chance(URGENT_SHARE) ? "urgent" : "normal";
}

/** What the bank's balance must cover for both queue heads to settle. */
function headsSum(bank: BankState): bigint {
  return (bank.queues.urgent[0]?.amount ?? 0n) + (bank.queues.normal[0]?.amount ?? 0n);
}

function queuedParams(world: WorldView, p: Payment): QueuedParams {
  return { id: p.id, amount: p.amount, toLabel: world.bank(p.to)?.label ?? p.to };
}

function describeQueued(p: QueuedParams): string {
  return `#${p.id}, ${usd(p.amount)} to ${p.toLabel}`;
}

function usd(amount: bigint): string {
  return `${formatAmount(amount)} ${CASH_CODE}`;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
