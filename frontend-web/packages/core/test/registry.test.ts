import { describe, expect, it } from "vitest";
import { loadNetworks } from "../src/network/networks.ts";
import { BankRegistry } from "../src/registry/banks.ts";
import { bankKey, nameKey, SETTLEMENT_KEY } from "../src/registry/ledger.ts";
import { devnetIdentities } from "../src/signer/keypair.ts";
import type { TxContext } from "../src/tx.ts";
import { A, B, CB, CONTRACT } from "./helpers.ts";

const [devnet, testnet] = loadNetworks({});
const ctx = {} as TxContext;

describe("bank registry", () => {
  it("merges config and event addresses, never listing the central bank or the contract", () => {
    const r = new BankRegistry(ctx, { ...testnet!, banks: [{ address: A, name: "Alpha" }, { address: CB }] }, CB, CONTRACT);
    expect(r.list()).toEqual([{ address: A, name: "Alpha", sources: ["config"] }]);
    let emitted = 0;
    r.subscribe(() => emitted++);
    expect(r.observe([A, B, CB, CONTRACT])).toEqual([B]);
    expect(r.get(A)!.sources).toEqual(["config", "events"]);
    expect(r.get(B)).toEqual({ address: B, sources: ["events"] });
    expect(emitted).toBe(1);
    expect(r.observe([A, B])).toEqual([]);
    expect(emitted).toBe(1);
    expect(r.nameOf(CB)).toBe("Central bank");
    expect(r.nameOf(B)).toMatch(/^G\w{3}…\w{4}$/);
  });

  it("names devnet identities by address", () => {
    const ids = devnetIdentities(devnet!, 2);
    const r = new BankRegistry(ctx, devnet!, ids.centralBank.address, CONTRACT);
    r.observe([ids.banks[1]!.address]);
    expect(r.get(ids.banks[1]!.address)).toEqual({ address: ids.banks[1]!.address, name: "Bank 2", sources: ["events", "devnet"] });
  });

  it("keeps ledger keys within the 64-byte limit", () => {
    for (const key of [SETTLEMENT_KEY, bankKey(9999), nameKey(9999)]) expect(Buffer.byteLength(key)).toBeLessThanOrEqual(64);
  });
});
