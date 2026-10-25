import { describe, expect, it, vi } from "vitest";
import { loadNetworks } from "../src/network/networks.ts";
import type { Signer } from "../src/signer/signer.ts";
import type { TxContext } from "../src/tx.ts";
import { A, CB, CONTRACT } from "./helpers.ts";

// The ledger reads and writes are faked: what's under test is how BankRegistry orders them.
const ledger = { banks: [] as { index: number; address: string; name?: string }[], delay: 0 };
vi.mock("../src/registry/ledger.ts", () => ({
  readLedgerBanks: vi.fn(async () => {
    const snapshot = ledger.banks.map((b) => ({ ...b }));
    await new Promise((r) => setTimeout(r, ledger.delay));
    return snapshot;
  }),
  registerBank: vi.fn(async (_ctx: unknown, _cb: unknown, _central: unknown, b: { address: string; name?: string }) => {
    ledger.banks.push({ index: ledger.banks.length, ...b });
    return {};
  }),
  unregisterBank: vi.fn(async () => ({})),
}));

const { BankRegistry } = await import("../src/registry/banks.ts");
const [, testnet] = loadNetworks({});

describe("bank registry ordering", () => {
  it("doesn't let a read that a registration overtook undo it", async () => {
    const registry = new BankRegistry({} as TxContext, testnet!, CB, CONTRACT);
    ledger.delay = 30;
    const loading = registry.load(); // reads the ledger before the registration
    ledger.delay = 0;
    await registry.register({ address: CB } as Signer, { address: A, name: "New bank" });
    expect(registry.get(A)?.name).toBe("New bank");
    await loading;
    expect(registry.get(A)?.name).toBe("New bank");
  });

  it("returns the same list until the registry changes", async () => {
    const registry = new BankRegistry({} as TxContext, testnet!, CB, CONTRACT);
    await registry.load();
    const first = registry.list();
    await registry.load();
    expect(registry.list()).toBe(first);
    registry.observe(["GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ"]);
    expect(registry.list()).not.toBe(first);
  });
});
