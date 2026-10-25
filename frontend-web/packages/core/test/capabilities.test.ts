import { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { classify, parseCapabilityOverrides } from "../src/capabilities.ts";

const error = (text: string) => ({ error: text, id: "1", latestLedger: 1, events: [] }) as unknown as rpc.Api.SimulateTransactionResponse;

describe("capability classification", () => {
  it("reads a Wasm trap (todo!()) as a stub", () => {
    expect(classify(error("HostError: Error(WasmVm, InvalidAction)\n\nEvent log ..."))).toBe("stub");
    expect(classify(undefined, new Error("... Error(WasmVm, InvalidAction) ..."))).toBe("stub");
  });

  it("reads a contract error or a result as available", () => {
    expect(classify(error("HostError: Error(Contract, #6)"))).toBe("available");
    expect(
      classify({ id: "1", latestLedger: 1, events: [], _parsed: true, transactionData: {}, minResourceFee: "1" } as unknown as rpc.Api.SimulateTransactionResponse),
    ).toBe("available");
  });

  it("reads anything else as unknown", () => {
    expect(classify(error("HostError: Error(Budget, ExceededLimit)"))).toBe("unknown");
    expect(classify(undefined, new Error("fetch failed"))).toBe("unknown");
  });

  it("parses overrides and ignores unknown names", () => {
    expect(parseCapabilityOverrides("expire=available, credit=stub, bogus=stub, repo=maybe")).toEqual({
      expire: "available",
      credit: "stub",
    });
  });
});
