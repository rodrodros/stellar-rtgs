import { describe, expect, it } from "vitest";
import { parseConfig, parseWhole } from "./setupForm.ts";

describe("the bootstrap form", () => {
  it("accepts whole numbers within range only", () => {
    expect(parseWhole("16", 1)).toBe(16);
    expect(parseWhole("", 1)).toBeUndefined();
    expect(parseWhole("1.5", 1)).toBeUndefined();
    expect(parseWhole("0", 1)).toBeUndefined();
    expect(parseWhole("-3", 0)).toBeUndefined();
    expect(parseWhole("21", 1, 20)).toBeUndefined();
  });

  it("names every invalid Config field; an empty field is not zero", () => {
    expect(parseConfig({ queueCap: "", expirySecs: "10", repoTermSecs: "1.5", penaltyRateBps: "0" })).toEqual({
      invalid: ["queueCap", "repoTermSecs"],
    });
    expect(parseConfig({ queueCap: "16", expirySecs: "86400", repoTermSecs: "86400", penaltyRateBps: "500" })).toEqual({
      config: { queueCap: 16, expirySecs: 86_400, repoTermSecs: 86_400, penaltyRateBps: 500 },
    });
  });
});
