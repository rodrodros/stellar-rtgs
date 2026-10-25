// The central bank's cash token administration: issue, clawback, deauthorize and reauthorize
// a trustline. Ticket 05.
//
// Issue and clawback keep each bank's holding between the tuning's floor and ceiling, so the
// economy neither drains into the contract nor piles up in one trustline. Deauthorization
// locks one bank out of deposit and withdraw for a while; the module remembers when, so it can
// let the bank back in, and `recover` reauthorizes whatever a stopped or crashed run left
// locked.
import { formatAmount } from "@rtgs/core";
import type { ActionDef, ActionModule, Actors, World } from "../types.ts";

/** With no bank below the floor, `issue` still applies this often, with a small amount. */
const IDLE_ISSUE_CHANCE = 0.05;

export interface TokenAmountParams {
  bank: string;
  label: string;
  amount: bigint;
}

export interface DeauthorizeParams {
  bank: string;
  label: string;
  /** Ledger time the plan was made; recorded once the deauthorization lands. */
  at: number;
}

export interface ReauthorizeParams {
  bank: string;
  label: string;
}

/**
 * The token module with its own deauthorization record (bank address -> ledger time), so each
 * test gets fresh state.
 */
export function createTokenActions(): ActionModule {
  const deauthorizedAt = new Map<string, number>();

  const issue: ActionDef<TokenAmountParams> = {
    name: "issue",
    group: "token",
    role: "central-bank",
    plan: ({ world, rng, tuning }) => {
      // An unauthorized trustline can't receive a payment.
      const open = world.banks().filter((b) => b.authorized);
      const low = open.filter((b) => b.holding < tuning.holdingFloor);
      if (low.length > 0) {
        const b = rng.pick(low);
        const target = rng.bigint(tuning.holdingFloor, tuning.holdingCeiling);
        return { bank: b.address, label: b.label, amount: target - b.holding };
      }
      const room = open.filter((b) => b.holding < tuning.holdingCeiling);
      if (room.length === 0 || !rng.chance(IDLE_ISSUE_CHANCE)) return undefined;
      const b = rng.pick(room);
      const amount = min(rng.bigint(tuning.paymentSize.min, tuning.paymentSize.max), tuning.holdingCeiling - b.holding);
      return amount > 0n ? { bank: b.address, label: b.label, amount } : undefined;
    },
    run: (actors, _actor, p) => actors.tokenAdmin.issue(p.bank, p.amount),
    describe: (p) => `${formatAmount(p.amount)} to ${p.label}`,
    touches: (_actor, p) => [p.bank],
  };

  const clawback: ActionDef<TokenAmountParams> = {
    name: "clawback",
    group: "token",
    role: "central-bank",
    plan: ({ world, rng, tuning }) => {
      const high = world.banks().filter((b) => b.holding > tuning.holdingCeiling);
      if (high.length === 0) return undefined;
      const b = rng.pick(high);
      // Between half and all of the excess, so the holding stays at or above the ceiling.
      const excess = b.holding - tuning.holdingCeiling;
      const amount = rng.bigint(max(excess / 2n, 1n), excess);
      return { bank: b.address, label: b.label, amount };
    },
    run: (actors, _actor, p) => actors.tokenAdmin.clawback(p.bank, p.amount),
    describe: (p) => `${formatAmount(p.amount)} from ${p.label}`,
    touches: (_actor, p) => [p.bank],
  };

  const deauthorize: ActionDef<DeauthorizeParams> = {
    name: "deauthorize",
    group: "token",
    role: "central-bank",
    plan: ({ world, rng }) => {
      // At most one bank locked out at a time.
      if (world.banks().some((b) => !b.authorized)) return undefined;
      const b = rng.pick(world.banks());
      return { bank: b.address, label: b.label, at: world.now() };
    },
    run: async (actors, _actor, p) => {
      const tx = await actors.tokenAdmin.authorize(p.bank, false);
      deauthorizedAt.set(p.bank, p.at);
      return tx;
    },
    describe: (p) => `${p.label}'s trustline`,
    touches: (_actor, p) => [p.bank],
  };

  const reauthorize: ActionDef<ReauthorizeParams> = {
    name: "reauthorize",
    group: "token",
    role: "central-bank",
    plan: ({ world, rng, tuning }) => {
      // A bank found deauthorized with no record (another run's, or someone else's) is due now.
      const due = world.banks().filter((b) => {
        if (b.authorized) return false;
        const at = deauthorizedAt.get(b.address);
        return at === undefined || world.now() - at >= tuning.deauthorizeSecs;
      });
      if (due.length === 0) return undefined;
      const b = rng.pick(due);
      return { bank: b.address, label: b.label };
    },
    run: async (actors, _actor, p) => {
      const tx = await actors.tokenAdmin.authorize(p.bank, true);
      deauthorizedAt.delete(p.bank);
      return tx;
    },
    describe: (p) => `${p.label}'s trustline`,
    touches: (_actor, p) => [p.bank],
  };

  return {
    group: "token",
    actions: [issue, clawback, deauthorize, reauthorize],
    /**
     * Reauthorizes every deauthorized bank, one transaction at a time (they share the central
     * bank's sequence number), then refreshes them. Tries them all before throwing the first
     * error, so one failure doesn't leave the others locked out.
     */
    async recover(actors: Actors, world: World) {
      const locked = world.banks().filter((b) => !b.authorized);
      if (locked.length === 0) return;
      let error: unknown;
      for (const b of locked) {
        try {
          await actors.tokenAdmin.authorize(b.address, true);
          deauthorizedAt.delete(b.address);
        } catch (e) {
          error ??= e;
        }
      }
      await world.refresh(locked.map((b) => b.address));
      if (error !== undefined) throw error;
    },
  };
}

export const tokenActions: ActionModule = createTokenActions();

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
