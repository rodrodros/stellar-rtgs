import { describe, expect, it } from "vitest";
import { conservation } from "./conservation.ts";

describe("conservation", () => {
  it("holds when the contract holds exactly the recorded balances", () => {
    expect(conservation(600n, [100n, 500n, 0n])).toEqual({ held: 600n, recorded: 600n, difference: 0n, holds: true });
  });

  it("flags a direct clawback from the contract (hazard H1)", () => {
    const c = conservation(500n, [600n]);
    expect(c.holds).toBe(false);
    expect(c.difference).toBe(-100n);
  });
});
