import type { FeedEvent } from "../types.ts";

export type FlowMatrix = Map<string, Map<string, bigint>>;

/** Liquidity that settled from each bank to each other bank, summed over `Settled` events. */
export function flowMatrix(events: readonly FeedEvent[], opts: { sinceLedger?: number } = {}): FlowMatrix {
  const matrix: FlowMatrix = new Map();
  for (const e of events) {
    if (e.type !== "Settled" || (opts.sinceLedger !== undefined && e.ledger < opts.sinceLedger)) continue;
    const row = matrix.get(e.from) ?? new Map<string, bigint>();
    row.set(e.to, (row.get(e.to) ?? 0n) + e.amount);
    matrix.set(e.from, row);
  }
  return matrix;
}

/** Each bank's net position over the same events: received minus paid. */
export function netFlows(matrix: FlowMatrix): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const [from, row] of matrix) {
    for (const [to, amount] of row) {
      net.set(from, (net.get(from) ?? 0n) - amount);
      net.set(to, (net.get(to) ?? 0n) + amount);
    }
  }
  return net;
}
