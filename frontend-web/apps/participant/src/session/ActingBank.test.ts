import { devnetIdentities, loadNetworks } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { matchIdentity } from "./ActingBank.tsx";

describe("matchIdentity", () => {
  const banks = devnetIdentities(loadNetworks({})[0]!, 3).banks;
  it("accepts an index, a label or an address", () => {
    expect(matchIdentity("2", banks)).toBe(banks[1]);
    expect(matchIdentity("bank-3", banks)).toBe(banks[2]);
    expect(matchIdentity("Bank 1", banks)).toBe(banks[0]);
    expect(matchIdentity(banks[1]!.address, banks)).toBe(banks[1]);
    expect(matchIdentity("9", banks)).toBeUndefined();
    expect(matchIdentity(null, banks)).toBeUndefined();
  });
});
