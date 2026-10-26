// pnpm devnet:bootstrap [--network devnet|testnet] [--rpc http://localhost:8300/rpc] [--banks 3] [--seed <seed>] [--fresh] [--wasm <path>]
// Sets up a devnet (or seeded testnet) deployment (src/devnet/bootstrap.ts) and prints it as JSON.
import { parseArgs } from "node:util";
import { bootstrapDevnet } from "../src/devnet/bootstrap.ts";
import { loadNetworks, withOverrides } from "../src/network/networks.ts";
import { readSettlementWasm } from "../src/node/index.ts";

const { values } = parseArgs({
  options: {
    network: { type: "string", default: process.env.RTGS_NETWORK || "devnet" },
    rpc: { type: "string" },
    banks: { type: "string", default: "3" },
    seed: { type: "string" },
    wasm: { type: "string" },
    fresh: { type: "boolean", default: false },
  },
});

if (values.network !== "devnet" && values.network !== "testnet") {
  console.error(`bootstrap failed: --network must be devnet or testnet, not ${values.network}`);
  process.exit(1);
}
const seedVar = values.network === "devnet" ? "RTGS_DEVNET_SEED" : "RTGS_TESTNET_SEED";
const env = { ...process.env, ...(values.seed ? { [seedVar]: values.seed } : {}) };
const selected = loadNetworks(env).find((n) => n.id === values.network)!;
const network = values.rpc ? withOverrides(selected, { rpcUrl: values.rpc }) : selected;

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
