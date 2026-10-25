import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { resultCodes } from "../src/tx.ts";

describe("transaction result codes", () => {
  it("reads Horizon-style codes from a failed transaction", () => {
    const result = xdr.TransactionResult.fromXdrObject({
      feeCharged: 100n,
      result: { code: -1, results: [{ code: 0, tr: { type: 1, paymentResult: { code: -6 } } }] },
      ext: { v: 0 },
    } as never);
    expect(resultCodes(result)).toEqual(["tx_failed", "op_no_trust"]);
  });

  it("reads a transaction-level code", () => {
    const result = xdr.TransactionResult.fromXdrObject({ feeCharged: 100n, result: { code: -5 }, ext: { v: 0 } } as never);
    expect(resultCodes(result)).toEqual(["tx_bad_seq"]);
  });
});
