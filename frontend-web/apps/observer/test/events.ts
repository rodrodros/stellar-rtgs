// Event builders for the observer's tests. Addresses are readable placeholders: the observer
// never parses them.
import type { EventMeta, Priority, RtgsEvent, TokenEvent } from "@rtgs/core";

export const A = "GBANKA";
export const B = "GBANKB";
export const C = "GBANKC";
export const CB = "GCENTRALBANK";
export const CONTRACT = "CSETTLEMENT";

let seq = 0;

/** Events of one transaction: each call to `tx` makes a new hash and ledger. */
export function tx(ledger: number, build: (m: () => EventMeta) => (RtgsEvent | TokenEvent)[]): (RtgsEvent | TokenEvent)[] {
  const hash = `tx-${ledger}-${++seq}`;
  let i = 0;
  return build(() => ({
    eventId: `${String(ledger).padStart(19, "0")}-${String(++i).padStart(10, "0")}`,
    ledger,
    closedAt: 1_800_000_000 + ledger * 5,
    txHash: hash,
    contractId: CONTRACT,
  }));
}

export const deposited = (m: EventMeta, bank: string, amount: bigint): RtgsEvent => ({ ...m, type: "Deposited", bank, amount });
export const withdrawn = (m: EventMeta, bank: string, amount: bigint): RtgsEvent => ({ ...m, type: "Withdrawn", bank, amount });
export const submitted = (m: EventMeta, id: bigint, from: string, to: string, amount: bigint, priority: Priority = "normal"): RtgsEvent => ({
  ...m,
  type: "Submitted",
  id,
  from,
  to,
  amount,
  priority,
});
export const settled = (m: EventMeta, id: bigint, from: string, to: string, amount: bigint): RtgsEvent => ({ ...m, type: "Settled", id, from, to, amount });
export const offset = (m: EventMeta, ids: bigint[]): RtgsEvent => ({ ...m, type: "Offset", ids });
export const revoked = (m: EventMeta, id: bigint): RtgsEvent => ({ ...m, type: "Revoked", id });
export const reprioritised = (m: EventMeta, id: bigint, priority: Priority): RtgsEvent => ({ ...m, type: "Reprioritised", id, priority });
export const expired = (m: EventMeta, id: bigint): RtgsEvent => ({ ...m, type: "Expired", id });
export const transfer = (m: EventMeta, from: string, to: string, amount: bigint): TokenEvent => ({ ...m, type: "Token", action: "transfer", from, to, amount });
