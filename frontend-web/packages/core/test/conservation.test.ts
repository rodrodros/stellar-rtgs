import { describe, expect, it, vi } from "vitest";
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { readConservation } from "../src/contract/conservation.ts";
import { A, B, C, CONTRACT, SAC, i128, map } from "./helpers.ts";

// A balance entry as RPC returns it: `owner`'s `Balance(holder)` in persistent storage.
const entry = (owner: string, holder: string, val: unknown) => ({
  val: {
    type: "contractData",
    value: {
      contract: new Address(owner).toScAddress(),
      key: nativeToScVal(["Balance", holder], { type: ["symbol", "address"] }),
      val,
    },
  },
});

const ctx = (entries: unknown[], latestLedger = 42) =>
  ({ server: { getLedgerEntries: vi.fn(async () => ({ entries, latestLedger })) } }) as never;

/** The keys a read asked RPC for, decoded: owner contract, durability, and the `Balance(holder)` key. */
function requested(c: unknown): { owner: string; durability: string; key: unknown }[] {
  const server = (c as { server: { getLedgerEntries: ReturnType<typeof vi.fn> } }).server;
  return (server.getLedgerEntries.mock.calls[0] as xdr.LedgerKey[]).map((k) => {
    // Through the wire format and back, so the test sees what RPC would.
    const data = (xdr.LedgerKey.fromXDR(k.toXDR()) as unknown as { contractData: { contract: xdr.ScAddress; key: xdr.ScVal; durability: unknown } }).contractData;
    return { owner: Address.fromScAddress(data.contract).toString(), durability: JSON.parse(JSON.stringify(data.durability)) as string, key: scValToNative(data.key) };
  });
}

describe("readConservation", () => {
  it("asks for the SAC's Balance(contract) and the contract's Balance(account), persistent", async () => {
    const c = ctx([]);
    await readConservation(c, CONTRACT, SAC, [A, B]);
    expect(requested(c)).toEqual([
      { owner: SAC, durability: "persistent", key: ["Balance", CONTRACT] },
      { owner: CONTRACT, durability: "persistent", key: ["Balance", A] },
      { owner: CONTRACT, durability: "persistent", key: ["Balance", B] },
    ]);
  });

  it("reads the contract's holding and every balance in one call, at one ledger", async () => {
    const c = ctx([
      entry(SAC, CONTRACT, map({ amount: i128(300), authorized: nativeToScVal(true), clawback: nativeToScVal(true) })),
      entry(CONTRACT, A, i128(100)),
      entry(CONTRACT, B, i128(200)),
    ]);
    const read = await readConservation(c, CONTRACT, SAC, [A, B, C, A]);
    expect((c as { server: { getLedgerEntries: ReturnType<typeof vi.fn> } }).server.getLedgerEntries).toHaveBeenCalledTimes(1);
    expect(read).toMatchObject({ ledger: 42, held: 300n, recorded: 300n, difference: 0n, holds: true });
    expect([...read.balances]).toEqual([
      [A, 100n],
      [B, 200n],
      [C, 0n],
    ]);
  });

  it("reports the difference when the holding and the balances disagree", async () => {
    const c = ctx([entry(SAC, CONTRACT, map({ amount: i128(250), authorized: nativeToScVal(true), clawback: nativeToScVal(true) })), entry(CONTRACT, A, i128(100))]);
    expect(await readConservation(c, CONTRACT, SAC, [A])).toMatchObject({ held: 250n, recorded: 100n, difference: 150n, holds: false });
  });

  it("ignores a SAC balance of anyone but the contract", async () => {
    const c = ctx([entry(SAC, A, map({ amount: i128(999), authorized: nativeToScVal(true), clawback: nativeToScVal(true) }))]);
    expect(await readConservation(c, CONTRACT, SAC, [A])).toMatchObject({ held: 0n, recorded: 0n, holds: true });
  });
});
