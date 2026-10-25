import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../src/amount.ts";

describe("amounts", () => {
  it("formats stroops exactly", () => {
    expect(formatAmount(12_345_000_000n)).toBe("1234.5");
    expect(formatAmount(1n)).toBe("0.0000001");
    expect(formatAmount(0n)).toBe("0");
    expect(formatAmount(-25_000_000n)).toBe("-2.5");
    expect(formatAmount(170141183460469231731687303715884105727n)).toBe("17014118346046923173168730371588.4105727");
  });

  it("parses decimals exactly and round-trips", () => {
    expect(parseAmount("1234.5")).toBe(12_345_000_000n);
    expect(parseAmount(" 1,000 ")).toBe(10_000_000_000n);
    expect(parseAmount("1,234,567.5")).toBe(12_345_675_000_000n);
    expect(parseAmount("0.0000001")).toBe(1n);
    for (const s of ["0", "7", "0.1", "99999999999.9999999"]) expect(formatAmount(parseAmount(s))).toBe(s);
    expect(formatAmount(parseAmount("-3.25", { allowNegative: true }))).toBe("-3.25");
  });

  it("refuses what it can't represent", () => {
    expect(() => parseAmount("1.00000001")).toThrow(/decimal places/);
    expect(() => parseAmount("abc")).toThrow(/not an amount/);
    expect(() => parseAmount("1e5")).toThrow();
    expect(() => parseAmount("1,2,3")).toThrow(/not an amount/);
    expect(() => parseAmount("12,34")).toThrow(/not an amount/);
    expect(() => parseAmount("-1")).toThrow(/negative/);
  });
});
