// From the bindings' shapes (or raw `scValToNative` output, for types the spec doesn't define
// yet) to the domain types, and back for arguments.
import { toPriority } from "../events/decode.ts";
import type { Config, Credit, Payment, PaymentStatus, Priority, Repo, RepoStatus } from "../types.ts";

function tagOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return String(value[0]);
  return String((value as { tag?: unknown } | null)?.tag);
}

const num = (v: unknown) => Number(v as bigint | number);
const big = (v: unknown) => BigInt(v as bigint | number);

export function toPaymentStatus(value: unknown): PaymentStatus {
  const tag = tagOf(value).toLowerCase();
  if (tag === "queued" || tag === "settled" || tag === "revoked" || tag === "expired") return tag;
  throw new Error(`not a payment status: ${tag}`);
}

export function toRepoStatus(value: unknown): RepoStatus {
  const tag = tagOf(value).toLowerCase();
  if (tag === "intraday" || tag === "penalty" || tag === "repaid") return tag;
  throw new Error(`not a repo status: ${tag}`);
}

export function fromPriority(priority: Priority): { tag: "Urgent" | "Normal"; values: undefined } {
  return { tag: priority === "urgent" ? "Urgent" : "Normal", values: undefined };
}

type Raw = Record<string, unknown>;

export function toConfig(raw: Raw): Config {
  return {
    queueCap: num(raw.queue_cap),
    expirySecs: num(raw.expiry_secs),
    repoTermSecs: num(raw.repo_term_secs),
    penaltyRateBps: num(raw.penalty_rate_bps),
  };
}

export function toPayment(raw: Raw): Payment {
  const payment: Payment = {
    id: big(raw.id),
    from: String(raw.from),
    to: String(raw.to),
    amount: big(raw.amount),
    priority: toPriority(raw.priority),
    submittedAt: num(raw.submitted_at),
    status: toPaymentStatus(raw.status),
  };
  if (raw.settled_at !== undefined && raw.settled_at !== null) payment.settledAt = num(raw.settled_at);
  return payment;
}

export function toCredit(raw: Raw): Credit {
  return { intraday: big(raw.cr), penalty: big(raw.ovn), collateral: big(raw.coll) };
}

export function toRepo(raw: Raw): Repo {
  return {
    id: big(raw.id),
    bank: String(raw.bank),
    amount: big(raw.amount),
    outstanding: big(raw.outstanding),
    openedAt: num(raw.opened_at),
    status: toRepoStatus(raw.status),
    rateBps: num(raw.rate_bps),
  };
}
