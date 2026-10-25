// What a transaction did, read from the settlement contract's events in it. The same rules as
// core's reducer (`via` on a settled step): a payment order settled in an `Offset` settled by
// the offset; one submitted in this transaction and settled in it settled at once; any other
// settlement was released by the eager closure the transaction ran.
import type { Priority, RtgsEvent } from "@rtgs/core";

export interface TxFacts {
  /** Payment orders this transaction submitted that are still queued after it. */
  queued: bigint[];
  settled: {
    /** Submitted in this transaction and settled in it, not by an offset. */
    atOnce: bigint[];
    /** Queued before, released by gross settlement in the eager closure. */
    eagerClosure: bigint[];
    /** Settled by an offset of the eager closure. */
    offset: bigint[];
  };
  /** Each `Offset` event's ids. */
  offsets: bigint[][];
  repos: {
    opened: { id: bigint; bank: string; amount: bigint }[];
    repaid: { id: bigint; amount: bigint; outstanding: bigint }[];
    penalised: { id: bigint; rateBps: number }[];
  };
  revoked: bigint[];
  reprioritised: { id: bigint; priority: Priority }[];
}

export function txFacts(events: readonly RtgsEvent[]): TxFacts {
  const facts: TxFacts = {
    queued: [],
    settled: { atOnce: [], eagerClosure: [], offset: [] },
    offsets: [],
    repos: { opened: [], repaid: [], penalised: [] },
    revoked: [],
    reprioritised: [],
  };
  // An `Offset` precedes its `Settled` events, but don't rely on the order.
  const offsetIds = new Set<bigint>();
  const submitted: bigint[] = [];
  for (const e of events) {
    if (e.type === "Offset") {
      facts.offsets.push([...e.ids]);
      for (const id of e.ids) offsetIds.add(id);
    } else if (e.type === "Submitted") {
      submitted.push(e.id);
    }
  }
  const settledIds = new Set<bigint>();
  for (const e of events) {
    switch (e.type) {
      case "Settled":
        settledIds.add(e.id);
        if (offsetIds.has(e.id)) facts.settled.offset.push(e.id);
        else if (submitted.includes(e.id)) facts.settled.atOnce.push(e.id);
        else facts.settled.eagerClosure.push(e.id);
        break;
      case "RepoOpened":
        facts.repos.opened.push({ id: e.id, bank: e.bank, amount: e.amount });
        break;
      case "RepoRepaid":
        facts.repos.repaid.push({ id: e.id, amount: e.amount, outstanding: e.outstanding });
        break;
      case "RepoPenalised":
        facts.repos.penalised.push({ id: e.id, rateBps: e.rateBps });
        break;
      case "Revoked":
        facts.revoked.push(e.id);
        break;
      case "Reprioritised":
        facts.reprioritised.push({ id: e.id, priority: e.priority });
        break;
    }
  }
  facts.queued = submitted.filter((id) => !settledIds.has(id));
  return facts;
}
