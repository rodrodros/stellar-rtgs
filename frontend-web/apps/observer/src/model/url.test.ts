import { describe, expect, it } from "vitest";
import { formatQuery, parseQuery } from "./url.ts";

const CONTRACT = `C${"A".repeat(55)}`;
const HASH = "ab".repeat(32);

describe("url query", () => {
  it("defaults to the whole retention window and nothing open", () => {
    expect(parseQuery("")).toEqual({ from: "retention" });
    expect(formatQuery({ from: "retention" })).toBe("");
  });

  it("round-trips every field", () => {
    const query = { network: "testnet", contract: CONTRACT, from: 1234, payment: 42n, tx: HASH, ledger: 678 };
    expect(parseQuery(formatQuery(query))).toEqual(query);
  });

  it("drops values that can't be what they claim", () => {
    expect(parseQuery("?payment=-1&tx=xyz&from=soon&ledger=x")).toEqual({ from: "retention" });
  });

  it("keeps an invalid contract id, so the app can refuse it instead of watching another contract", () => {
    const query = parseQuery("?contract=CABC");
    expect(query).toEqual({ from: "retention", invalidContract: "CABC" });
    expect(formatQuery(query)).toBe("?contract=CABC");
  });

  it("keeps an unknown network as written, for the app to refuse", () => {
    expect(parseQuery("?network=mainnet").network).toBe("mainnet");
  });

  it("normalises a transaction hash to lower case", () => {
    expect(parseQuery(`?tx=${HASH.toUpperCase()}`).tx).toBe(HASH);
  });
});
