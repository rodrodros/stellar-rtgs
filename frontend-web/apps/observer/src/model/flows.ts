// Liquidity flows between banks as a payer × payee matrix: what settled in the loaded window
// (core's `flowMatrix`), its bilateral net, or what still waits in the queues.
import type { BankView, FlowMatrix } from "../core.ts";

const get = (m: FlowMatrix, from: string, to: string): bigint => m.get(from)?.get(to) ?? 0n;

function set(m: FlowMatrix, from: string, to: string, amount: bigint): void {
  const row = m.get(from) ?? new Map<string, bigint>();
  row.set(to, amount);
  m.set(from, row);
}

/** For each pair, only the direction that paid more, by the difference. */
export function bilateralNet(m: FlowMatrix): FlowMatrix {
  const net: FlowMatrix = new Map();
  for (const [from, row] of m) {
    for (const [to, amount] of row) {
      const diff = amount - get(m, to, from);
      if (diff > 0n) set(net, from, to, diff);
    }
  }
  return net;
}

/** Payment orders waiting in the banks' queues, summed per sender and receiver. */
export function queuedMatrix(banks: Iterable<BankView>): FlowMatrix {
  const m: FlowMatrix = new Map();
  for (const bank of banks) {
    for (const p of [...bank.queues.urgent, ...bank.queues.normal]) set(m, p.from, p.to, get(m, p.from, p.to) + p.amount);
  }
  return m;
}

export function cell(m: FlowMatrix, from: string, to: string): bigint {
  return get(m, from, to);
}

export function maxCell(m: FlowMatrix): bigint {
  let max = 0n;
  for (const row of m.values()) for (const v of row.values()) if (v > max) max = v;
  return max;
}

export function rowTotal(m: FlowMatrix, from: string): bigint {
  let sum = 0n;
  for (const v of m.get(from)?.values() ?? []) sum += v;
  return sum;
}

export function columnTotal(m: FlowMatrix, to: string): bigint {
  let sum = 0n;
  for (const row of m.values()) sum += row.get(to) ?? 0n;
  return sum;
}

/** The matrix's axes: `order` first (e.g. the registry), then any other address the matrix mentions. */
export function axis(m: FlowMatrix, order: readonly string[]): string[] {
  const seen = new Set(order);
  const extra: string[] = [];
  for (const [from, row] of m) {
    for (const a of [from, ...row.keys()]) {
      if (!seen.has(a)) {
        seen.add(a);
        extra.push(a);
      }
    }
  }
  return [...order, ...extra];
}

/** A cell's shade, 0 to 1, relative to the largest cell. */
export function intensity(amount: bigint, max: bigint): number {
  if (max <= 0n || amount <= 0n) return 0;
  return Number((amount * 1000n) / max) / 1000;
}
