/**
 * The settlement Wasm committed with the bindings, for the browser bootstrap. Vite turns the
 * `new URL(..., import.meta.url)` into a bundled asset. In Node use `readSettlementWasm` from
 * "@rtgs/core/node".
 */
export async function loadSettlementWasm(): Promise<Uint8Array> {
  const response = await fetch(new URL("../../wasm/settlement.wasm", import.meta.url));
  if (!response.ok) throw new Error(`could not load settlement.wasm (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
