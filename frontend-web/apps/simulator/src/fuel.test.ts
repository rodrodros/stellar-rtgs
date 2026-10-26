import { RtgsError } from "@rtgs/core";
import { describe, expect, it, vi } from "vitest";
import { BANK_1, BANK_2, CB } from "../test/fakes.ts";
import { createRefueler, type RefuelResult } from "./fuel.ts";

const XLM = 10_000_000n;

function setup(balances: Record<string, bigint | Error>, refuel = vi.fn(async (_a: string) => 10_000n * XLM)) {
  const results: [string, RefuelResult][] = [];
  const refueler = createRefueler({
    lanes: [BANK_1, BANK_2, CB],
    belowStroops: 2_000n * XLM,
    xlmBalance: async (a) => {
      const b = balances[a]!;
      if (b instanceof Error) throw b;
      return b;
    },
    refuel,
    onRefuel: (a, r) => results.push([a, r]),
  });
  return { refueler, refuel, results };
}

describe("createRefueler", () => {
  it("refuels only the lanes below the threshold", async () => {
    const { refueler, refuel, results } = setup({ [BANK_1]: 1_999n * XLM, [BANK_2]: 2_000n * XLM, [CB]: 5n });
    await refueler.check();
    expect(refuel.mock.calls.map(([a]) => a)).toEqual([BANK_1, CB]);
    expect(results).toEqual([
      [BANK_1, { amount: 10_000n * XLM }],
      [CB, { amount: 10_000n * XLM }],
    ]);
  });

  it("reports a failed refuel and goes on; skips a balance it couldn't read", async () => {
    const refuel = vi.fn(async (a: string) => {
      if (a === BANK_1) throw new RtgsError("rpc", "Friendbot refused", "HTTP 500");
      return 1n;
    });
    const { refueler, results } = setup({ [BANK_1]: 0n, [BANK_2]: new Error("fetch failed"), [CB]: 0n }, refuel);
    await refueler.check();
    expect(results.map(([a, r]) => [a, "error" in r ? r.error.title : r.amount])).toEqual([
      [BANK_1, "Friendbot refused"],
      [CB, 1n],
    ]);
  });

  it("runs one check at a time", async () => {
    let release!: () => void;
    const refuel = vi.fn(() => new Promise<bigint>((r) => (release = () => r(1n))));
    const { refueler } = setup({ [BANK_1]: 0n, [BANK_2]: 9_999n * XLM, [CB]: 9_999n * XLM }, refuel);
    const first = refueler.check();
    const second = refueler.check();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(refuel).toHaveBeenCalledTimes(1));
    release();
    await first;
    expect(refuel).toHaveBeenCalledTimes(1);
  });
});
