// The sentences the payment views show, kept pure so they can be tested.
import type { Capability, LifecycleStep, PaymentRecord, QueueAnalysis, TxOutcome } from "@rtgs/core";
import { amountText } from "../ui/format.ts";

/**
 * What happened to a submitted payment order, read from its own transaction. `ahead`: how many
 * of the bank's queued payment orders come before it in queue order (urgent ones first).
 */
export function describeSubmit(
  outcome: Pick<TxOutcome<{ id: bigint; disposition: "settled" | "queued" }>, "value" | "events">,
  priority: "urgent" | "normal",
  ahead?: number,
): string {
  const { id, disposition } = outcome.value;
  const list = (ids: bigint[]) => ids.map((i) => `#${i}`).join(", ");
  // An offset publishes `Offset{ids}` and then a `Settled` for each of them (lib.rs).
  const offset = outcome.events.flatMap((e) => (e.type === "Offset" ? e.ids : []));
  const inOffset = offset.includes(id);
  const offsetOthers = offset.filter((i) => i !== id);
  const released = outcome.events.flatMap((e) => (e.type === "Settled" && e.id !== id && !offset.includes(e.id) ? [e.id] : []));
  const head =
    disposition === "settled"
      ? inOffset
        ? `Payment order #${id} settled in an offset${offsetOthers.length ? ` with ${list(offsetOthers)}` : ""}.`
        : `Payment order #${id} settled at once.`
      : `Payment order #${id} queued in your ${priority} queue${
          ahead === undefined ? "" : ahead === 0 ? ", first in queue order" : `, behind ${ahead} other payment order${ahead === 1 ? "" : "s"}`
        }.`;
  const sentences = [head];
  if (released.length) sentences.push(`The eager closure also settled ${list(released)}.`);
  if (!inOffset && offsetOthers.length) sentences.push(`An offset also settled ${list(offsetOthers)}.`);
  return sentences.join(" ");
}

/** Why a queue's head is waiting, in glossary terms. */
export function headNote(analysis: QueueAnalysis, balance: bigint, code?: string): string | undefined {
  const head = analysis.head;
  if (!head) return undefined;
  if (analysis.blockedBy === "urgent-queued") return "Waits behind your urgent payment orders, which go first.";
  if (analysis.blockedBy === "uncovered") {
    const shortfall = head.amount - (balance > 0n ? balance : 0n);
    return `Blocked queue head: your custody balance doesn't cover it. ${amountText(shortfall, code)} more is needed, from a deposit or an incoming payment, or it settles in an offset with payment orders queued to you.`;
  }
  return "Covered: it settles on the next eager closure.";
}

/**
 * The expiry line for a queued payment order (ADR-0015). `past`: core's `isExpired` at the
 * ledger clock, which the local clock advances between ledgers, so near the boundary the line
 * may turn a few seconds before `expire` would accept the payment order.
 */
export function expiryNote(past: boolean, expire: Capability): { past: boolean; text: string } {
  if (!past) return { past: false, text: "Expires" };
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
