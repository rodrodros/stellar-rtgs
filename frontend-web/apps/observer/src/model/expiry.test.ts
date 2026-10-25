import type { Config, Payment } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { expiryOf, formatDuration } from "./expiry.ts";

const config: Config = { queueCap: 16, expirySecs: 600, repoTermSecs: 86_400, penaltyRateBps: 500 };
const payment = { id: 1n, from: "A", to: "B", amount: 1n, priority: "normal", submittedAt: 1000, status: "queued" } as Payment;

describe("expiryOf", () => {
  it("counts down to submission + expiry", () => {
    expect(expiryOf(payment, config, 1100)).toEqual({ kind: "running", at: 1600, secondsLeft: 500 });
  });

  it("has passed only after the expiry time, as the contract's expire checks it", () => {
    expect(expiryOf(payment, config, 1600)).toEqual({ kind: "running", at: 1600, secondsLeft: 0 });
    expect(expiryOf(payment, config, 1601)).toEqual({ kind: "passed", at: 1600, secondsAgo: 1 });
  });

  it("is unknown without the config or the ledger clock", () => {
    expect(expiryOf(payment, undefined, 1100)).toEqual({ kind: "unknown" });
    expect(expiryOf(payment, config, undefined)).toEqual({ kind: "unknown" });
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0 s"],
    [45, "45 s"],
    [60, "1 min"],
    [3_720, "1 h 2 min"],
    [3_600, "1 h"],
    [86_400 + 3_600 + 61, "1 d 1 h"],
    [604_800, "7 d"],
    [-5, "0 s"],
  ])("%i s -> %s", (secs, text) => {
    expect(formatDuration(secs)).toBe(text);
  });
});
