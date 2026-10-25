// Node-only helpers (`@rtgs/core/node`): file access the browser build must not import.
import { readFile } from "node:fs/promises";

/** The settlement Wasm committed with the bindings (wasm/settlement.wasm). */
export async function readSettlementWasm(path?: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path ?? new URL("../../wasm/settlement.wasm", import.meta.url)));
}
