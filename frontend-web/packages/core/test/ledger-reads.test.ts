import { Asset, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { loadNetworks } from "../src/network/networks.ts";
import { BankRegistry } from "../src/registry/banks.ts";
import { bankKey, nameKey } from "../src/registry/ledger.ts";
import { CashTokenReader } from "../src/token/cash-token.ts";
import { accountLoadError, type TxContext } from "../src/tx.ts";
import { A, B, CB, CONTRACT } from "./helpers.ts";

const [devnet, testnet] = loadNetworks({});
const asset = new Asset("USD", CB);
const token = { sacId: asset.contractId(devnet!.passphrase), code: "USD", issuer: CB, asset };
const ctxWith = (server: object, net = devnet!) => ({ server, net }) as unknown as TxContext;

describe("cash token holdings", () => {
  it("reads a trustline's balance and flags from the ledger", async () => {
    const server = { getLedgerEntries: vi.fn(async () => ({ entries: [{ val: { type: "trustline", trustLine: { balance: 50n, flags: 1 | 4 } } }] })) };
    expect(await new CashTokenReader(ctxWith(server), token).holding(A)).toEqual({
      balance: 50n,
      exists: true,
      authorized: true,
      authorizedToMaintainLiabilities: false,
      clawbackEnabled: true,
    });
  });

  it("reads no entry as no trustline, but an RPC failure as an error", async () => {
    const empty = { getLedgerEntries: vi.fn(async () => ({ entries: [] })) };
    expect(await new CashTokenReader(ctxWith(empty), token).holding(A)).toMatchObject({ exists: false, balance: 0n });
    const down = { getLedgerEntries: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) };
    await expect(new CashTokenReader(ctxWith(down), token).holding(A)).rejects.toMatchObject({ kind: "rpc" });
  });
});

describe("account load errors", () => {
  const notFound = new Error(`Account not found: ${A}`);

  it("says 'No such account' only when the ledger has no such account", async () => {
    const missing = { getLedgerEntries: vi.fn(async () => ({ entries: [] })) };
    expect(await accountLoadError(ctxWith(missing), A, notFound)).toMatchObject({ title: "No such account" });
    const present = { getLedgerEntries: vi.fn(async () => ({ entries: [{}] })) };
    expect(await accountLoadError(ctxWith(present), A, notFound)).not.toMatchObject({ title: "No such account" });
  });

  it("reports an RPC failure as one", async () => {
    const down = { getLedgerEntries: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) };
    await expect(accountLoadError(ctxWith(down), A, notFound)).rejects.toMatchObject({ kind: "rpc" });
    expect(await accountLoadError(ctxWith(down), A, new TypeError("fetch failed"))).toMatchObject({ kind: "rpc" });
  });
});

/** A fake RPC holding data entries of the central bank's account. */
function dataServer(entries: Map<string, string>) {
  return {
    getLedgerEntries: vi.fn(async (...keys: xdr.LedgerKey[]) => ({
      entries: keys
        .map((k) => (k as unknown as { data: { dataName: { toString(): string } } }).data.dataName.toString())
        .filter((name) => entries.has(name))
        .map((name) => ({ val: { type: "data", data: { dataName: name, dataValue: { value: Buffer.from(entries.get(name)!) } } } })),
    })),
  };
}

describe("bank registry reloads", () => {
  it("drops banks and names the ledger no longer has, keeping config names", async () => {
    const data = new Map([
      [bankKey(0), A],
      [nameKey(0), "Alpha"],
      [bankKey(1), B],
      [nameKey(1), "Beta"],
    ]);
    const registry = new BankRegistry(ctxWith(dataServer(data), testnet!), { ...testnet!, banks: [{ address: B, name: "Beta (config)" }] }, CB, CONTRACT);
    await registry.load();
    expect(registry.list()).toEqual([
      { address: B, name: "Beta", sources: ["config", "ledger"] },
      { address: A, name: "Alpha", sources: ["ledger"] },
    ]);
    data.delete(bankKey(0));
    data.delete(nameKey(0));
    data.delete(nameKey(1));
    const seen = vi.fn();
    registry.subscribe(seen);
    await registry.load();
    expect(registry.list()).toEqual([{ address: B, name: "Beta (config)", sources: ["config", "ledger"] }]);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
