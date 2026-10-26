import type { FeedStatus } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { checkStartLedger, parseStart, retentionWindow, toFeedStart } from "./retention.ts";

const status: FeedStatus = {
  state: "live",
  clamped: false,
  oldestLedger: 1_000,
  oldestLedgerCloseTime: 100_000,
  latestLedger: 2_000,
  latestLedgerCloseTime: 105_000,
};

describe("start choice", () => {
  it("parses the query value", () => {
    expect(parseStart(null)).toBe("recent");
    expect(parseStart("retention")).toBe("retention");
    expect(parseStart("now")).toBe("now");
    expect(parseStart("1234")).toBe(1234);
    expect(parseStart("-1")).toBe("recent");
    expect(parseStart("12x")).toBe("recent");
  });

  it("maps to core's feed start", () => {
    expect(toFeedStart("recent")).toBe("recent");
    expect(toFeedStart("retention")).toBe("retention-start");
    expect(toFeedStart("now")).toBe("now");
    expect(toFeedStart(42)).toEqual({ ledger: 42 });
  });
});

describe("retention window", () => {
  const window = retentionWindow(status)!;

  it("is unknown until the feed has reported both ends", () => {
    expect(retentionWindow({ state: "backfilling", clamped: false, oldestLedger: 1, latestLedger: 2 })).toBeUndefined();
    expect(window).toEqual({ oldestLedger: 1_000, latestLedger: 2_000, oldestCloseTime: 100_000, latestCloseTime: 105_000, ledgers: 1_001, spanSecs: 5_000 });
  });

  it("checks a start ledger against the window", () => {
    expect(checkStartLedger(1_500, window)).toBeUndefined();
    expect(checkStartLedger(999, window)).toMatch(/oldest it keeps is 1000/);
    expect(checkStartLedger(2_001, window)).toMatch(/latest is 2000/);
    expect(checkStartLedger(0, window)).toMatch(/ledger number/);
    expect(checkStartLedger(5, undefined)).toBeUndefined();
  });
});
