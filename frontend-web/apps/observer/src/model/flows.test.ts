import type { BankView, FlowMatrix, Payment } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { A, B, C } from "../../test/events.ts";
import { axis, bilateralNet, cell, columnTotal, intensity, maxCell, queuedMatrix, rowTotal } from "./flows.ts";

const matrix = (entries: [string, string, bigint][]): FlowMatrix => {
  const m: FlowMatrix = new Map();
  for (const [from, to, v] of entries) m.set(from, new Map([...(m.get(from) ?? []), [to, v]]));
  return m;
};

const payment = (id: bigint, from: string, to: string, amount: bigint): Payment => ({
  id,
  from,
  to,
  amount,
  priority: "normal",
  submittedAt: 0,
  status: "queued",
});

describe("flows", () => {
  const m = matrix([
    [A, B, 500n],
    [B, A, 200n],
    [B, C, 100n],
    [C, A, 100n],
    [A, C, 100n],
  ]);

  it("nets each pair to the direction that paid more", () => {
    const net = bilateralNet(m);
    expect(cell(net, A, B)).toBe(300n);
    expect(cell(net, B, A)).toBe(0n);
    expect(cell(net, B, C)).toBe(100n);
    expect(cell(net, A, C)).toBe(0n);
    expect(cell(net, C, A)).toBe(0n);
  });

  it("totals rows and columns and finds the largest cell", () => {
    expect(rowTotal(m, A)).toBe(600n);
    expect(columnTotal(m, A)).toBe(300n);
    expect(maxCell(m)).toBe(500n);
    expect(maxCell(new Map())).toBe(0n);
  });

  it("sums the queued payment orders per sender and receiver", () => {
    const banks = [
      { address: A, balance: 0n, queues: { urgent: [payment(1n, A, B, 10n)], normal: [payment(2n, A, B, 5n), payment(3n, A, C, 1n)] } },
      { address: B, balance: 0n, queues: { urgent: [], normal: [payment(4n, B, A, 7n)] } },
    ] as unknown as BankView[];
    const q = queuedMatrix(banks);
    expect(cell(q, A, B)).toBe(15n);
    expect(cell(q, A, C)).toBe(1n);
    expect(cell(q, B, A)).toBe(7n);
  });

  it("orders the axis by the given order, then by first mention", () => {
    expect(axis(m, [C])).toEqual([C, A, B]);
  });

  it("shades relative to the largest cell", () => {
    expect(intensity(250n, 500n)).toBe(0.5);
    expect(intensity(0n, 500n)).toBe(0);
    expect(intensity(1n, 0n)).toBe(0);
  });
});
