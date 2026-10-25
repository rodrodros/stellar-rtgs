import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { failedTransaction, footprintRace, resultCodes } from "../src/tx.ts";

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

describe("failed transactions", () => {
  // As RPC decodes them: the host's storage error, then its explanation.
  const diagnostic = (topics: unknown[], data: unknown) => ({ event: { body: { v0: { topics, data } } } }) as never as xdr.DiagnosticEvent;
  const storageError = { type: "scvError", error: { type: "sceStorage", code: { name: "scecExceededLimit", value: 5 } } };
  const response = (diagnosticEventsXdr: xdr.DiagnosticEvent[]) =>
    ({
      status: "FAILED",
      diagnosticEventsXdr,
      resultXdr: xdr.TransactionResult.fromXdrObject({ feeCharged: 100n, result: { code: -1, results: [{ code: 0, tr: { type: 24, invokeHostFunctionResult: { code: -2 } } }] }, ext: { v: 0 } } as never),
    }) as never;

  it("names a footprint race, so a caller can send it again", () => {
    const failed = response([diagnostic([{ type: "scvSymbol" }, storageError], { type: "scvVec" })]);
    expect(footprintRace(failed)).toBe(true);
    const error = failedTransaction(failed, undefined);
    expect(error.kind).toBe("transaction");
    expect(error.title).toBe("State changed");
  });

  it("treats running out of the simulated resources as the same race", () => {
    const failed = {
      status: "FAILED",
      diagnosticEventsXdr: [],
      resultXdr: xdr.TransactionResult.fromXdrObject({ feeCharged: 100n, result: { code: -1, results: [{ code: 0, tr: { type: 24, invokeHostFunctionResult: { code: -3 } } }] }, ext: { v: 0 } } as never),
    } as never;
    const error = failedTransaction(failed, undefined);
    expect(error.title).toBe("State changed");
    expect(error.detail).toContain("op_resource_limit_exceeded");
  });

  it("leaves any other trap to its result codes", () => {
    const failed = response([diagnostic([{ type: "scvSymbol" }], { type: "scvVoid" })]);
    expect(footprintRace(failed)).toBe(false);
    expect(failedTransaction(failed, undefined).detail).toContain("op_trapped");
  });
});
