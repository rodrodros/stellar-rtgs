// What a bank's queues look like right now: heads, what blocks them, expiry (ADR-0008,
// ADR-0009, ADR-0015). Pure functions of views and the ledger clock.
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
  /** When the head may be rejected (Unix seconds of ledger close time). */
  expiresAt?: number;
  /** Whether the head's expiry has passed: a keeper may reject it now. */
  expired: boolean;
}

export interface BankQueues {
  urgent: QueueAnalysis;
  normal: QueueAnalysis;
}

/** The ledger time after which a queued payment order may be rejected (ADR-0015). */
export function expiresAt(payment: Payment, config: Config): number {
  return payment.submittedAt + config.expirySecs;
}

/** `rtgs_core::covers`: paying leaves the sender's balance non-negative. */
export function covers(balance: bigint, amount: bigint): boolean {
  return balance - amount >= 0n;
}

function analyse(priority: Priority, queue: Payment[], balance: bigint, urgentQueued: boolean, config?: Config, now?: number): QueueAnalysis {
  const head = queue[0];
  const analysis: QueueAnalysis = { priority, length: queue.length, covered: false, expired: false };
  if (!head) return analysis;
  analysis.head = head;
  analysis.covered = covers(balance, head.amount);
  if (priority === "normal" && urgentQueued) analysis.blockedBy = "urgent-queued";
  else if (!analysis.covered) analysis.blockedBy = "uncovered";
  if (config) {
    analysis.expiresAt = expiresAt(head, config);
    analysis.expired = now !== undefined && now >= analysis.expiresAt;
  }
  return analysis;
}

/** `now`: the latest ledger's close time, the RTGS's clock (not the local clock). */
export function analyseQueues(
  balance: bigint,
  queues: { urgent: Payment[]; normal: Payment[] },
  config?: Config,
  now?: number,
): BankQueues {
  return {
    urgent: analyse("urgent", queues.urgent, balance, false, config, now),
    normal: analyse("normal", queues.normal, balance, queues.urgent.length > 0, config, now),
  };
}
