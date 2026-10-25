import type { Config, Payment, Repo } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { expirablePayments, formatSpan, overdueRepos } from "./due.ts";

const config: Config = { queueCap: 16, expirySecs: 100, repoTermSecs: 1000, penaltyRateBps: 500 };
const payment = (id: bigint, submittedAt: number, status: Payment["status"] = "queued"): Payment => ({
  id,
  from: "GA",
  to: "GB",
  amount: 1n,
  priority: "normal",
  submittedAt,
  status,
});
const repo = (id: bigint, openedAt: number, status: Repo["status"] = "intraday"): Repo => ({
  id,
  bank: "GA",
  amount: 1n,
  outstanding: 1n,
  openedAt,
  status,
  rateBps: 0,
});

describe("expirablePayments", () => {
  it("follows the contract: due only strictly after submitted_at + expiry_secs", () => {
    const ps = [payment(2n, 0), payment(1n, 1), payment(3n, 5)];
    // now = 101: #2 (expiry 100) is past; #1 (expiry 101) is exactly at it, so not due.
    expect(expirablePayments(ps, config, 101).map((p) => p.id)).toEqual([2n]);
    expect(expirablePayments(ps, config, 102).map((p) => p.id)).toEqual([1n, 2n]);
  });

  it("ignores payment orders that are already final", () => {
    expect(expirablePayments([payment(1n, 0, "settled"), payment(2n, 0, "revoked"), payment(3n, 0, "expired")], config, 10_000)).toEqual([]);
  });
});

describe("overdueRepos", () => {
  it("is due only strictly after the term, and only for intraday repos (SC-A20-02)", () => {
    const rs = [repo(0n, 0), repo(1n, 0, "penalty"), repo(2n, 0, "repaid"), repo(3n, 1)];
    expect(overdueRepos(rs, config, 1000)).toEqual([]);
    expect(overdueRepos(rs, config, 1001).map((r) => r.id)).toEqual([0n]);
    expect(overdueRepos(rs, config, 1002).map((r) => r.id)).toEqual([0n, 3n]);
  });
});

describe("formatSpan", () => {
  it("reads as days, hours and minutes", () => {
    expect(formatSpan(90_061)).toBe("1d 1h 1m");
    expect(formatSpan(42)).toBe("42s");
    expect(formatSpan(0)).toBe("due");
  });
});
