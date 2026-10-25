// The timeline: events grouped by the transaction that emitted them, and, for each settlement,
// what released it. Every entry point publishes its own event first and the eager closure's
// `Settled` events after it (lib.rs), and an offset publishes `Offset{ids}` before the `Settled`
// of each payment order it settles, so one transaction's events explain all its settlements.
import type { FeedEvent, RtgsEvent, RtgsEventType } from "../core.ts";

type Settled = Extract<RtgsEvent, { type: "Settled" }>;

export interface Settlement {
  event: Settled;
  /** The same rules as core's lifecycle steps (`LifecycleStep.via`). */
  via: "at-once" | "eager-closure" | "offset";
  /**
   * eager-closure only: what made this payment order's head covered. Either the transaction's
   * trigger (a deposit, or a revocation or reprioritisation that changed the sender's queue
   * head), or an earlier settlement in the same cascade that credited the sender.
   */
  releasedBy?: { kind: "trigger" } | { kind: "payment"; id: bigint };
}

export interface TxGroup {
  txHash: string;
  ledger: number;
  closedAt: number;
  /** Every event of the transaction the feed delivered, in order (cash token events included). */
  events: FeedEvent[];
  /** The first settlement contract event: the action that started the transaction. */
  trigger?: RtgsEvent;
  settlements: Settlement[];
}

const isContractEvent = (e: FeedEvent): e is RtgsEvent => e.type !== "Token";

/** Explains each `Settled` event of one transaction's events (given in order). */
export function explainSettlements(events: readonly FeedEvent[]): Settlement[] {
  const contract = events.filter(isContractEvent);
  const trigger = contract[0];
  const offsetIds = new Set<bigint>();
  const out: Settlement[] = [];
  contract.forEach((event, i) => {
    if (event.type === "Offset") for (const id of event.ids) offsetIds.add(id);
    if (event.type !== "Settled") return;
    if (offsetIds.has(event.id)) {
      out.push({ event, via: "offset" });
    } else if (trigger?.type === "Submitted" && trigger.id === event.id) {
      out.push({ event, via: "at-once" });
    } else {
      const credit = contract
        .slice(0, i)
        .reverse()
        .find((e): e is Settled => e.type === "Settled" && e.to === event.from);
      out.push({ event, via: "eager-closure", releasedBy: credit ? { kind: "payment", id: credit.id } : { kind: "trigger" } });
    }
  });
  return out;
}

/**
 * Groups events by transaction, oldest first. Events arrive in RPC order, so a transaction's
 * events are contiguous. `truncated`: older events were dropped (core's store keeps a bounded
 * number), so the oldest transaction may have lost its first events and is left out, rather than
 * be explained from a part of it.
 */
export function groupByTransaction(events: readonly FeedEvent[], opts: { truncated?: boolean } = {}): TxGroup[] {
  const groups: TxGroup[] = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && last.txHash === event.txHash) last.events.push(event);
    else groups.push({ txHash: event.txHash, ledger: event.ledger, closedAt: event.closedAt, events: [event], settlements: [] });
  }
  if (opts.truncated) groups.shift();
  for (const g of groups) {
    const trigger = g.events.find(isContractEvent);
    if (trigger) g.trigger = trigger;
    g.settlements = explainSettlements(g.events);
  }
  return groups;
}

/** The timeline's filter categories. */
export const CATEGORIES = {
  liquidity: ["Deposited", "Withdrawn"],
  payments: ["Submitted", "Settled", "Offset", "Revoked", "Reprioritised", "Expired"],
  credit: ["CollateralSet", "RepoOpened", "RepoRepaid", "RepoPenalised"],
} as const satisfies Record<string, readonly RtgsEventType[]>;

export type Category = keyof typeof CATEGORIES | "token" | "other";

export function categoryOf(event: FeedEvent): Category {
  if (event.type === "Token") return "token";
  for (const [name, types] of Object.entries(CATEGORIES)) {
    if ((types as readonly string[]).includes(event.type)) return name as Category;
  }
  return "other";
}

/** Every address an event mentions. `senderOf` resolves a payment order id to its sender. */
export function addressesOf(event: FeedEvent, senderOf: (id: bigint) => string | undefined): string[] {
  switch (event.type) {
    case "Deposited":
    case "Withdrawn":
    case "CollateralSet":
    case "RepoOpened":
      return [event.bank];
    case "Submitted":
    case "Settled":
      return [event.from, event.to];
    case "Revoked":
    case "Reprioritised":
    case "Expired": {
      const from = senderOf(event.id);
      return from ? [from] : [];
    }
    case "Offset":
      return event.ids.map(senderOf).filter((a): a is string => !!a);
    case "Token":
      return [event.from, event.to].filter((a): a is string => !!a);
    default:
      return [];
  }
}

export interface TimelineFilter {
  categories: ReadonlySet<Category>;
  /** Only transactions that mention this bank. */
  bank?: string;
}

/** Keeps the groups with at least one event the filter shows. */
export function filterGroups(groups: readonly TxGroup[], filter: TimelineFilter, senderOf: (id: bigint) => string | undefined): TxGroup[] {
  return groups.filter((g) =>
    g.events.some(
      (e) => filter.categories.has(categoryOf(e)) && (!filter.bank || addressesOf(e, senderOf).includes(filter.bank)),
    ),
  );
}
