import { describe, expect, it } from "vitest";
import { amountText, countdown, duration, readAmount } from "./format.ts";

describe("format", () => {
  it("shows whole units, rounded, with thousands grouped", () => {
    expect(amountText(12_345_670_000_000n, "USD")).toBe("1,234,567 USD");
    expect(amountText(12_325_000_000n)).toBe("1,233");
    expect(amountText(12_324_999_999n)).toBe("1,232");
    expect(amountText(-5_000_000n)).toBe("-1");
    expect(amountText(-4_999_999n)).toBe("0");
  });

  it("formats durations and countdowns on the ledger clock", () => {
    expect(duration(0)).toBe("0s");
    expect(duration(61)).toBe("1m 1s");
    expect(duration(90_061)).toBe("1d 1h 1m");
    expect(countdown(1060, 1000)).toBe("in 1m 0s");
    expect(countdown(1000, 1060)).toBe("1m 0s ago");
    expect(countdown(1000, 1000)).toBe("in 0s");
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
