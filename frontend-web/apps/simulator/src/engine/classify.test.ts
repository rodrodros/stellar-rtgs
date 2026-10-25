import { RtgsError, toRtgsError } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { classify } from "./classify.ts";

// Each error is built the way core builds it: toRtgsError over the text RPC, the SDK or a
// failed transaction's result codes carry.
const cases: [string, RtgsError, ReturnType<typeof classify>][] = [
  ["InvalidAmount (1): a planning bug", toRtgsError("Error(Contract, #1)"), "failed"],
  ["TokenTransferFailed (2)", toRtgsError("Error(Contract, #2)"), "refused"],
  ["InsufficientFunds (3)", toRtgsError("Error(Contract, #3)"), "refused"],
  ["QueueFull (5)", toRtgsError("Error(Contract, #5)"), "refused"],
  ["NotQueued (7)", toRtgsError("Error(Contract, #7)"), "refused"],
  ["CollateralBelowCredit (11)", toRtgsError("Error(Contract, #11)"), "refused"],
  ["RepayExceedsRepo (14)", toRtgsError("Error(Contract, #14)"), "refused"],
  ["AlreadyPenalty (16)", toRtgsError("Error(Contract, #16)"), "refused"],
  ["an unknown contract code (17)", toRtgsError("Error(Contract, #17)"), "failed"],
  ["the SDK's Err for NotQueued", toRtgsError({ error: { message: "NotQueued" } }), "refused"],
  ["SAC BalanceError", toRtgsError("Error(Contract, #10)", "sac"), "refused"],
  ["SAC BalanceDeauthorizedError", toRtgsError("Error(Contract, #11)", "sac"), "refused"],
  ["SAC UnauthorizedError", toRtgsError("Error(Contract, #4)", "sac"), "failed"],
  ["classic op_underfunded", toRtgsError("tx_failed op_underfunded"), "refused"],
  ["classic op_not_authorized", toRtgsError("tx_failed op_not_authorized"), "refused"],
  ["classic op_no_trust", toRtgsError("tx_failed op_no_trust"), "failed"],
  ["tx_bad_seq", toRtgsError("tx_bad_seq"), "transient"],
  ["tx_insufficient_fee", toRtgsError("tx_insufficient_fee"), "transient"],
  ["TRY_AGAIN_LATER", new RtgsError("transaction", "Network busy", "RPC asked to try again later."), "transient"],
  ["a send that wasn't confirmed", new RtgsError("transaction", "Not confirmed", "Transaction ab was not seen in a closed ledger in time."), "transient"],
  ["tx_insufficient_balance", toRtgsError("tx_insufficient_balance"), "failed"],
  ["RPC's snapshot race", toRtgsError("setting ContractComputeV0 is not present in the snapshot"), "transient"],
  ["RPC unreachable", toRtgsError(new Error("fetch failed")), "transient"],
  ["a thrown TypeError", toRtgsError(new TypeError("cannot read properties of undefined")), "failed"],
  ["a thrown RangeError", toRtgsError(new RangeError("invalid array length")), "failed"],
  ["an HTTP 503 from RPC", toRtgsError(new Error("Request failed with status code 503")), "transient"],
  ["a dropped connection", toRtgsError(new Error("read ECONNRESET")), "transient"],
  ["a JSON-RPC error object", toRtgsError({ code: -32603, message: "internal error" }), "transient"],
  ["a Wasm trap", toRtgsError("Error(WasmVm, InvalidAction)"), "failed"],
  ["an archived entry", toRtgsError("EntryArchived"), "failed"],
];

describe("classify", () => {
  it.each(cases)("%s", (_name, error, expected) => {
    expect(classify(error)).toBe(expected);
  });

  it("classifies raw failures through toRtgsError", () => {
    expect(classify("Error(Contract, #7)")).toBe("refused");
    expect(classify(new Error("tx_bad_seq"))).toBe("transient");
  });
});
