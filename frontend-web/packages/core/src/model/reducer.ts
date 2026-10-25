// Folds events into payment orders with their lifecycle, repos and collateral. Statuses only
// move forward (queued -> settled / revoked / expired), so replaying history over state read
// from the views converges on the same result.
import type { FeedEvent, Payment, Priority, Repo, RtgsEvent, RtgsEventType } from "../types.ts";

export interface LifecycleStep {
  kind: "submitted" | "reprioritised" | "settled" | "revoked" | "expired";
  eventId: string;
  ledger: number;
  closedAt: number;
  txHash: string;
  /** submitted, reprioritised: the priority class it then had. */
  priority?: Priority;
  /**
   * settled: on submission ("at-once"), by the eager closure after another action released it
   * ("eager-closure"), or in an offset ("offset").
   */
  via?: "at-once" | "eager-closure" | "offset";
  /** settled by the eager closure: the action in the same transaction that released it. */
  trigger?: { type: RtgsEventType; actor?: string; paymentId?: bigint };
}

export interface PaymentRecord extends Payment {
  /** The steps the event feed has seen; empty for a payment order older than its window. */
  steps: LifecycleStep[];
}

export interface ModelState {
  payments: Map<bigint, PaymentRecord>;
  repos: Map<bigint, Repo>;
  /** Collateral values from `CollateralSet`. */
  collateral: Map<string, bigint>;
  /** The most recent events, oldest first. */
  events: FeedEvent[];
  /** Every bank address the events mention. */
  seen: Set<string>;
  /** The transaction being folded: its first event, and the ids of any offset in it. */
  tx?: { hash: string; first: RtgsEvent; offsetIds: Set<bigint> };
}

export const MAX_EVENTS = 2000;

export function emptyState(): ModelState {
  return { payments: new Map(), repos: new Map(), collateral: new Map(), events: [], seen: new Set() };
}

const FINAL = new Set(["settled", "revoked", "expired"]);

function step(event: RtgsEvent, kind: LifecycleStep["kind"], extra: Partial<LifecycleStep> = {}): LifecycleStep {
  return { kind, eventId: event.eventId, ledger: event.ledger, closedAt: event.closedAt, txHash: event.txHash, ...extra };
}

function addStep(record: PaymentRecord, s: LifecycleStep): PaymentRecord {
  if (record.steps.some((x) => x.eventId === s.eventId)) return record;
  return { ...record, steps: [...record.steps, s].sort((a, b) => (a.eventId < b.eventId ? -1 : 1)) };
}

/** Who acted in an event: the bank, or the sender of the payment order it concerns. */
function actorOf(state: ModelState, event: RtgsEvent): string | undefined {
  switch (event.type) {
    case "Deposited":
    case "Withdrawn":
    case "CollateralSet":
      return event.bank;
    case "Submitted":
      return event.from;
    case "Revoked":
    case "Reprioritised":
    case "Expired":
      return state.payments.get(event.id)?.from;
    default:
      return undefined;
  }
}

function paymentIdOf(event: RtgsEvent): bigint | undefined {
  return "id" in event && typeof event.id === "bigint" && !event.type.startsWith("Repo") ? event.id : undefined;
}

/** Folds one settlement event into `state` (mutating the maps of a state the caller owns). */
function apply(state: ModelState, event: RtgsEvent): void {
  if (!state.tx || state.tx.hash !== event.txHash) state.tx = { hash: event.txHash, first: event, offsetIds: new Set() };
  const { payments } = state;
  switch (event.type) {
    case "Deposited":
    case "Withdrawn":
      state.seen.add(event.bank);
      break;
    case "Submitted": {
      state.seen.add(event.from).add(event.to);
      const existing = payments.get(event.id);
      const base: PaymentRecord = existing ?? {
        id: event.id,
        from: event.from,
        to: event.to,
        amount: event.amount,
        priority: event.priority,
        submittedAt: event.closedAt,
        status: "queued",
        steps: [],
      };
      payments.set(event.id, addStep(base, step(event, "submitted", { priority: event.priority })));
      break;
    }
    case "Settled": {
      state.seen.add(event.from).add(event.to);
      const record = payments.get(event.id) ?? {
        id: event.id,
        from: event.from,
        to: event.to,
        amount: event.amount,
        priority: "normal" as Priority,
        submittedAt: event.closedAt,
        status: "queued" as const,
        steps: [],
      };
      const submittedHere = record.steps.some((s) => s.kind === "submitted" && s.txHash === event.txHash);
      const first = state.tx.first;
      const extra: Partial<LifecycleStep> = state.tx.offsetIds.has(event.id)
        ? { via: "offset" }
        : submittedHere && first.type === "Submitted" && first.id === event.id
          ? { via: "at-once" }
          : {
              via: "eager-closure",
              trigger: {
                type: first.type,
                ...(actorOf(state, first) ? { actor: actorOf(state, first)! } : {}),
                ...(paymentIdOf(first) !== undefined ? { paymentId: paymentIdOf(first)! } : {}),
              },
            };
      payments.set(event.id, addStep({ ...record, status: "settled", settledAt: event.closedAt }, step(event, "settled", extra)));
      break;
    }
    case "Offset":
      for (const id of event.ids) state.tx.offsetIds.add(id);
      break;
    case "Revoked":
    case "Expired": {
      const record = payments.get(event.id);
      if (!record) break;
      const status = event.type === "Revoked" ? "revoked" : "expired";
      payments.set(event.id, addStep({ ...record, status }, step(event, status)));
      break;
    }
    case "Reprioritised": {
      const record = payments.get(event.id);
      if (!record) break;
      const priority = FINAL.has(record.status) ? record.priority : event.priority;
      payments.set(event.id, addStep({ ...record, priority }, step(event, "reprioritised", { priority: event.priority })));
      break;
    }
    case "CollateralSet":
      state.seen.add(event.bank);
      state.collateral.set(event.bank, event.value);
      break;
    case "RepoOpened":
      state.seen.add(event.bank);
      state.repos.set(event.id, {
        id: event.id,
        bank: event.bank,
        amount: event.amount,
        outstanding: event.amount,
        openedAt: event.closedAt,
        status: "intraday",
        rateBps: 0,
        ...state.repos.get(event.id),
      });
      break;
    case "RepoRepaid": {
      const repo = state.repos.get(event.id);
      if (repo) state.repos.set(event.id, { ...repo, outstanding: event.outstanding, status: event.outstanding === 0n ? "repaid" : repo.status });
      break;
    }
    case "RepoPenalised": {
      const repo = state.repos.get(event.id);
      if (repo && repo.status !== "repaid") state.repos.set(event.id, { ...repo, status: "penalty", rateBps: event.rateBps });
      break;
    }
    case "Unknown":
      break;
  }
}

/** Returns a new state with `batch` folded in; `state` is left as it was. */
export function applyEvents(state: ModelState, batch: readonly FeedEvent[]): ModelState {
  const next: ModelState = {
    payments: new Map(state.payments),
    repos: new Map(state.repos),
    collateral: new Map(state.collateral),
    events: state.events,
    seen: new Set(state.seen),
    ...(state.tx ? { tx: state.tx } : {}),
  };
  const known = new Set(state.events.map((e) => e.eventId));
  const fresh = batch.filter((e) => !known.has(e.eventId));
  for (const event of fresh) if (event.type !== "Token") apply(next, event);
  next.events = [...state.events, ...fresh].slice(-MAX_EVENTS);
  return next;
}

/**
 * Merges payment orders read from the views. A view is authoritative for its status, but
 * never moves a final status back to queued, and the lifecycle seen in events is kept.
 */
export function mergePayments(state: ModelState, payments: readonly Payment[]): ModelState {
  const next = new Map(state.payments);
  for (const p of payments) {
    const known = next.get(p.id);
    if (!known) {
      next.set(p.id, { ...p, steps: [] });
      continue;
    }
    const status = FINAL.has(known.status) && p.status === "queued" ? known.status : p.status;
    next.set(p.id, { ...known, ...p, status, steps: known.steps });
  }
  return { ...state, payments: next };
}

export function mergeRepos(state: ModelState, repos: readonly Repo[]): ModelState {
  const next = new Map(state.repos);
  for (const r of repos) next.set(r.id, r);
  return { ...state, repos: next };
}
