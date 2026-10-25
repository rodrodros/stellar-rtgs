// pnpm devnet:bootstrap [--rpc http://localhost:8300/rpc] [--banks 3] [--seed <seed>] [--fresh] [--wasm <path>]
// Sets up a devnet deployment (src/devnet/bootstrap.ts) and prints it as JSON.
import { parseArgs } from "node:util";
import { bootstrapDevnet } from "../src/devnet/bootstrap.ts";
import { loadNetworks, withOverrides } from "../src/network/networks.ts";
import { readSettlementWasm } from "../src/node/index.ts";

const { values } = parseArgs({
  options: {
    rpc: { type: "string" },
    banks: { type: "string", default: "3" },
    seed: { type: "string" },
    wasm: { type: "string" },
    fresh: { type: "boolean", default: false },
  },
});

const env = { ...process.env, ...(values.seed ? { RTGS_DEVNET_SEED: values.seed } : {}) };
const devnet = loadNetworks(env).find((n) => n.id === "devnet")!;
const network = values.rpc ? withOverrides(devnet, { rpcUrl: values.rpc }) : devnet;

try {
  const deployment = await bootstrapDevnet({
    network,
    wasm: await readSettlementWasm(values.wasm),
    banks: Number(values.banks),
    fresh: values.fresh,
    onStep: (s) => console.error(`${s.status.padEnd(7)} ${s.step}${s.detail ? ` ${s.detail}` : ""}`),
  });
  console.log(JSON.stringify(deployment, null, 2));
} catch (e) {
  console.error(`bootstrap failed: ${(e as Error).message}`);
  process.exit(1);
}
