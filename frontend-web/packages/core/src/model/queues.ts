// What a bank's queues look like: heads, what blocks them, expiry (ADR-0008, ADR-0009,
// ADR-0015). Pure functions of the views; whether something has expired depends on the ledger
// clock, so it is asked with `isExpired(…, now)` rather than stored.
import type { Config, Payment, Priority } from "../types.ts";

export interface QueueAnalysis {
  priority: Priority;
  length: number;
  /** The payment order first in queue order. */
  head?: Payment;
  /** Whether the bank's balance covers the head (the balance after paying it stays >= 0). */
  covered: boolean;
  /**
   * Why the head waits: its sender's balance doesn't cover it, or (normal queue only) the bank
   * has urgent payment orders queued, which go first (S7).
   */
  blockedBy?: "uncovered" | "urgent-queued";
  /** The head's expiry; see `expiresAt`. */
  expiresAt?: number;
}

export interface BankQueues {
  urgent: QueueAnalysis;
  normal: QueueAnalysis;
}

/**
 * A queued payment order's expiry (ADR-0015), in ledger time. The contract rejects it only
 * once the ledger time is strictly after this (`expire` refuses with `NotExpired` at it).
 */
export function expiresAt(payment: Payment, config: Config): number {
  return payment.submittedAt + config.expirySecs;
}

/** Whether a keeper may reject the queued payment order at ledger time `now`. */
export function isExpired(payment: Payment, config: Config, now: number): boolean {
  return payment.status === "queued" && now > expiresAt(payment, config);
}

/** Every queued payment order a keeper may reject at `now`, oldest first. */
export function expirablePayments(payments: Iterable<Payment>, config: Config, now: number): Payment[] {
  return [...payments].filter((p) => isExpired(p, config, now)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `rtgs_core::covers`: paying leaves the sender's balance non-negative. */
export function covers(balance: bigint, amount: bigint): boolean {
  return balance - amount >= 0n;
}

function analyse(priority: Priority, queue: Payment[], balance: bigint, urgentQueued: boolean, config?: Config): QueueAnalysis {
  const head = queue[0];
  const analysis: QueueAnalysis = { priority, length: queue.length, covered: false };
  if (!head) return analysis;
  analysis.head = head;
  analysis.covered = covers(balance, head.amount);
  if (priority === "normal" && urgentQueued) analysis.blockedBy = "urgent-queued";
  else if (!analysis.covered) analysis.blockedBy = "uncovered";
  if (config) analysis.expiresAt = expiresAt(head, config);
  return analysis;
}

export function analyseQueues(balance: bigint, queues: { urgent: Payment[]; normal: Payment[] }, config?: Config): BankQueues {
  return {
    urgent: analyse("urgent", queues.urgent, balance, false, config),
    normal: analyse("normal", queues.normal, balance, queues.urgent.length > 0, config),
  };
}
