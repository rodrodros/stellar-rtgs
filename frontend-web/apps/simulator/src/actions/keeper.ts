// Keeper operations, which anyone may send and the central bank's lane does here: expire a
// queued payment order past its expiry (A5, ADR-0015) and turn a repo past its term into a
// penalty repo (ADR-0014). Both only apply once something is due, which on the devnet's
// defaults is a day in (`expirySecs`, `repoTermSecs`); before that their plans return nothing.
// The matching rules are core's (`expirablePayments`, `overdueRepos`), measured against ledger
// time, so a plan never asks the contract for something it would refuse as not yet due.
import { expirablePayments, overdueRepos } from "@rtgs/core";
import type { ActionDef, ActionModule, WorldView } from "../types.ts";

export interface ExpireParams {
  id: bigint;
  /** The sender's label. */
  from: string;
}

export interface ConvertOverdueParams {
  repoId: bigint;
  /** The repo's bank's label. */
  bank: string;
}

const labelOf = (world: WorldView, address: string) => world.bank(address)?.label ?? address;

/** The oldest queued payment order past its expiry. */
export const expire: ActionDef<ExpireParams> = {
  name: "expire",
  group: "keeper",
  role: "central-bank",
  capability: "expire",
  plan({ world }) {
    const [p] = expirablePayments(world.queuedPayments(), world.config(), world.now());
    return p && { id: p.id, from: labelOf(world, p.from) };
  },
  run: (actors, _actor, p) => actors.centralBank.expire(p.id),
  describe: (p) => `#${p.id} from ${p.from}`,
  touches: () => [],
};

/** The oldest intraday repo past its term. */
export const convertOverdue: ActionDef<ConvertOverdueParams> = {
  name: "convertOverdue",
  group: "keeper",
  role: "central-bank",
  capability: "convertOverdue",
  plan({ world }) {
    const [r] = overdueRepos(world.repos(), world.config(), world.now());
    return r && { repoId: r.id, bank: labelOf(world, r.bank) };
  },
  run: (actors, _actor, p) => actors.centralBank.convertOverdue(p.repoId),
  describe: (p) => `repo #${p.repoId} of ${p.bank}`,
  touches: () => [],
};

export const keeperActions: ActionModule = { group: "keeper", actions: [expire, convertOverdue] };
