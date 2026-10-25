import { describe, expect, it, vi } from "vitest";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
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

describe("readConservation", () => {
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
