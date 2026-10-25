import { describe, expect, it } from "vitest";
import { amountText, countdown, duration, readAmount } from "./format.ts";

describe("format", () => {
  it("groups thousands and keeps the exact fraction", () => {
    expect(amountText(12_345_670_000_000n, "USD")).toBe("1,234,567 USD");
    expect(amountText(12_345_000_001n)).toBe("1,234.5000001");
    expect(amountText(-5_000_000n)).toBe("-0.5");
  });

  it("formats durations and countdowns on the ledger clock", () => {
    expect(duration(0)).toBe("0s");
    expect(duration(61)).toBe("1m 1s");
    expect(duration(90_061)).toBe("1d 1h 1m");
    expect(countdown(1060, 1000)).toBe("in 1m 0s");
    expect(countdown(1000, 1060)).toBe("1m 0s ago");
  });

  it("reads only positive amounts with at most 7 decimals", () => {
    expect(readAmount("1,000.5")).toEqual({ ok: true, value: 10_005_000_000n });
    expect(readAmount("")).toMatchObject({ ok: false, message: "Enter an amount." });
    expect(readAmount("0")).toMatchObject({ ok: false, message: "The amount must be greater than zero." });
    expect(readAmount("-3")).toMatchObject({ ok: false });
    expect(readAmount("1.12345678")).toMatchObject({ ok: false, message: "Enter a number with at most 7 decimal places." });
    expect(readAmount("abc")).toMatchObject({ ok: false });
  });
});
