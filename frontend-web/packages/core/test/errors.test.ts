import { contract } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CONTRACT_ERRORS, retryTransient, RtgsError, toRtgsError } from "../src/errors.ts";
import { wasm } from "./helpers.ts";

describe("error mapping", () => {
  it("has a message for every error case in the deployed Wasm's spec (drift guard)", () => {
    const cases = contract.Spec.fromWasm(wasm()).errorCases();
    expect(cases.length).toBeGreaterThanOrEqual(16);
    for (const c of cases) {
      expect(CONTRACT_ERRORS[c.value], `error ${c.value}`).toBeDefined();
      expect(CONTRACT_ERRORS[c.value]!.name).toBe(c.name.toString());
    }
  });

  it("maps a contract error in a simulation message", () => {
    const e = toRtgsError('HostError: Error(Contract, #5)\n\nEvent log (newest first): ...');
    expect(e).toMatchObject({ kind: "contract", code: 5, title: "Central queue full" });
    expect(e.detail).toMatch(/queue cap/);
  });

  it("maps the SDK's Err({ message }) by name", () => {
    expect(toRtgsError({ error: { message: "SameAccount" } })).toMatchObject({ kind: "contract", code: 4 });
  });

  it("reads a SAC error as the cash token's when asked", () => {
    expect(toRtgsError("Error(Contract, #13)", "sac")).toMatchObject({ kind: "token", title: "No trustline" });
  });

  it("reads a Wasm trap as a stub", () => {
    expect(toRtgsError("HostError: Error(WasmVm, InvalidAction)")).toMatchObject({ kind: "not-implemented" });
  });

  it("maps classic result codes, RPC outages and wallet refusals", () => {
    expect(toRtgsError("tx_bad_seq")).toMatchObject({ kind: "transaction" });
    expect(toRtgsError("op_not_authorized")).toMatchObject({ kind: "token", title: "Trustline not authorized" });
    expect(toRtgsError(new TypeError("fetch failed"))).toMatchObject({ kind: "rpc", title: "Network unreachable" });
    expect(toRtgsError(new Error("User rejected the request"))).toMatchObject({ kind: "wallet" });
  });

  it("maps a missing contract and a missing data entry", () => {
    expect(toRtgsError("HostError: Error(Storage, MissingValue)")).toMatchObject({ kind: "config", title: "Nothing deployed there" });
    expect(toRtgsError("tx_failed op_success op_name_not_found")).toMatchObject({ title: "No such data entry" });
  });

  it("names the cash token's issuer, not the central bank (spec fact 3)", () => {
    for (const t of Object.values(CONTRACT_ERRORS)) expect(t.detail).not.toMatch(/central bank/i);
    expect(toRtgsError("op_not_authorized").detail).not.toMatch(/central bank/i);
  });

  it("maps RPC's transient snapshot race and retries it", async () => {
    const race = "setting ContractComputeV0 is not present in the snapshot";
    expect(toRtgsError(race)).toMatchObject({ kind: "rpc", title: "Network busy" });
    let calls = 0;
    expect(
      await retryTransient(async () => {
        calls += 1;
        if (calls < 3) throw toRtgsError(race);
        return "ok";
      }),
    ).toBe("ok");
    calls = 0;
    await expect(
      retryTransient(async () => {
        calls += 1;
        throw toRtgsError(race);
      }),
    ).rejects.toMatchObject({ title: "Network busy" });
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      retryTransient(async () => {
        calls += 1;
        throw toRtgsError("Error(Contract, #5)");
      }),
    ).rejects.toMatchObject({ code: 5 });
    expect(calls).toBe(1);
  });

  it("passes an RtgsError through", () => {
    const e = new RtgsError("config", "x", "y");
    expect(toRtgsError(e)).toBe(e);
  });
});
