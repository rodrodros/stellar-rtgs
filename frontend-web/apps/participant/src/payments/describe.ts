// The sentences the payment views show, kept pure so they can be tested.
import type { Capability, LifecycleStep, PaymentRecord, QueueAnalysis, TxOutcome } from "@rtgs/core";
import { amountText } from "../ui/format.ts";

/** What happened to a submitted payment order, read from its own transaction. */
export function describeSubmit(
  outcome: Pick<TxOutcome<{ id: bigint; disposition: "settled" | "queued" }>, "value" | "events">,
  priority: "urgent" | "normal",
  position?: number,
): string {
  const { id, disposition } = outcome.value;
  const released = outcome.events.filter((e) => e.type === "Settled" && e.id !== id).map((e) => `#${(e as { id: bigint }).id}`);
  const head =
    disposition === "settled"
      ? `Payment order #${id} settled at once.`
      : `Payment order #${id} queued${position ? ` at position ${position}` : ""} in your ${priority} queue.`;
  return released.length ? `${head} The eager closure also settled ${released.join(", ")}.` : head;
}

/** Why a queue's head is waiting, in glossary terms. */
export function headNote(analysis: QueueAnalysis, balance: bigint, code?: string): string | undefined {
  const head = analysis.head;
  if (!head) return undefined;
  if (analysis.blockedBy === "urgent-queued") return "Waits behind your urgent payment orders, which go first.";
  if (analysis.blockedBy === "uncovered") {
    const shortfall = head.amount - (balance > 0n ? balance : 0n);
    return `Blocked queue head: your settlement balance doesn't cover it. ${amountText(shortfall, code)} more is needed, from a deposit or an incoming payment.`;
  }
  return "Covered: it settles on the next eager closure.";
}

/**
 * The expiry line for a queued payment order (ADR-0015). `expire` accepts a payment order only
 * once the ledger's time is strictly past `expiresAt`. `now` is the ledger clock advanced by
 * the local clock, so near the boundary the line is a few seconds early at most.
 */
export function expiryNote(expiresAt: number, now: number | undefined, expire: Capability): { past: boolean; text: string } {
  if (now === undefined || now <= expiresAt) return { past: false, text: "Expires" };
  return {
    past: true,
    text: expire === "stub" ? "Past expiry; not enforced by this contract version" : "Past expiry; a keeper may reject it",
  };
}

/** How a settled payment order settled, from its lifecycle. */
export function settledVia(record: Pick<PaymentRecord, "steps">, nameOf: (address: string) => string): string | undefined {
  const step = [...record.steps].reverse().find((s): s is LifecycleStep => s.kind === "settled");
  if (!step) return undefined;
  if (step.via === "at-once") return "at once";
  if (step.via === "offset") return "in an offset";
  if (step.via === "eager-closure" && step.trigger) {
    const who = step.trigger.actor ? `${nameOf(step.trigger.actor)}'s ` : "";
    const what: Record<string, string> = {
      Deposited: "deposit",
      Submitted: "payment order",
      Revoked: "revocation",
      Reprioritised: "reprioritisation",
      Expired: "expiry",
    };
    return `released by ${who}${what[step.trigger.type] ?? step.trigger.type}`;
  }
  return "by the eager closure";
}
