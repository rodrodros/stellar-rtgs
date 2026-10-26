import { describe, expect, it } from "vitest";
import { formatQuery, parseQuery } from "./url.ts";

const CONTRACT = `C${"A".repeat(55)}`;
const HASH = "ab".repeat(32);

describe("url query", () => {
  it("defaults to recent history and nothing open", () => {
    expect(parseQuery("")).toEqual({ from: "recent" });
    expect(formatQuery({ from: "recent" })).toBe("");
    expect(formatQuery({ from: "retention" })).toBe("?from=retention");
  });

  it("round-trips every field", () => {
    for (const drawer of [{ payment: 42n }, { tx: HASH }, { ledger: 678 }]) {
      const query = { network: "testnet", contract: CONTRACT, from: 1234, ...drawer };
      expect(parseQuery(formatQuery(query))).toEqual(query);
    }
  });

  it("opens one drawer from a link naming several: payment, then tx, then ledger", () => {
    expect(parseQuery(`?payment=1&tx=${HASH}&ledger=2`)).toEqual({ from: "recent", payment: 1n });
    expect(parseQuery(`?tx=${HASH}&ledger=2`)).toEqual({ from: "recent", tx: HASH });
  });

  it("drops values that can't be what they claim", () => {
    expect(parseQuery("?payment=-1&tx=xyz&from=soon&ledger=x")).toEqual({ from: "recent" });
  });

  it("keeps an invalid contract id, so the app can refuse it instead of watching another contract", () => {
    const query = parseQuery("?contract=CABC");
    expect(query).toEqual({ from: "recent", invalidContract: "CABC" });
    expect(formatQuery(query)).toBe("?contract=CABC");
  });

  it("keeps an unknown network as written, for the app to refuse", () => {
    expect(parseQuery("?network=mainnet").network).toBe("mainnet");
  });

  it("normalises a transaction hash to lower case", () => {
    expect(parseQuery(`?tx=${HASH.toUpperCase()}`).tx).toBe(HASH);
  });
});
