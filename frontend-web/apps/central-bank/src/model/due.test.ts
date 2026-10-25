import type { Config, Repo } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { formatSpan, overdueRepos } from "./due.ts";

const config: Config = { queueCap: 16, expirySecs: 100, repoTermSecs: 1000, penaltyRateBps: 500 };
const repo = (id: bigint, openedAt: number, status: Repo["status"] = "intraday"): Repo => ({
  id,
  bank: "GA",
  amount: 1n,
  outstanding: 1n,
  openedAt,
  status,
  rateBps: 0,
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
