import { readFileSync } from "node:fs";
import { Address, Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import type { EventMeta } from "../src/types.ts";

export const A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
export const B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
export const C = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
export const CB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
export const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
export const SAC = StrKey.encodeContract(Buffer.alloc(32, 8));

export const wasm = () => readFileSync(new URL("../wasm/settlement.wasm", import.meta.url));

export const sym = (s: string) => xdr.ScVal.scvSymbol(s);
export const addr = (a: string) => new Address(a).toScVal();
export const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "u64" });
export const i128 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "i128" });
export const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
export const priority = (p: "Urgent" | "Normal") => xdr.ScVal.scvVec([sym(p)]);
/** A map with symbol keys, in key order (the host sorts map keys). */
export const map = (entries: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(entries)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: entries[k]! })),
  );

let seq = 0;
export function meta(ledger = 100, overrides: Partial<EventMeta> = {}): EventMeta {
  seq += 1;
  return {
    eventId: `${String(ledger).padStart(19, "0")}-${String(seq).padStart(10, "0")}`,
    ledger,
    closedAt: 1_800_000_000 + ledger * 5,
    txHash: `tx${ledger}`,
    contractId: CONTRACT,
    ...overrides,
  };
}
