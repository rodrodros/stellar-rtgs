// pnpm simulate [--rpc ...] [--banks 3] [--profile balanced] [--rate 2] ...
// Connects to the bootstrapped devnet and keeps its banks transacting until Ctrl-C. The
// pieces (world, policy, engine, reporter) are built here and nowhere else; flag parsing
// lives in policy/args.ts.
import { RtgsError, connect, devnetIdentities, loadNetworks, withOverrides } from "@rtgs/core";
import type { RtgsActor, RtgsSession } from "@rtgs/core";
import { MODULES } from "./actions/index.ts";
import { Engine } from "./engine/index.ts";
import { USAGE, parseCliArgs } from "./policy/args.ts";
import { createPolicy } from "./policy/index.ts";
import { createReporter, createReporterReads } from "./report/index.ts";
import { createRng } from "./rng.ts";
import type { Actors } from "./types.ts";
import { createWorld } from "./world/index.ts";

const parsed = parseCliArgs(process.argv.slice(2));
if (parsed.kind === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`pnpm simulate: ${parsed.message}\n\n${USAGE}`);
  process.exit(1);
}
const args = parsed.args;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const env = { ...process.env, ...(args.seed ? { RTGS_DEVNET_SEED: args.seed } : {}) };
const devnet = loadNetworks(env).find((n) => n.id === "devnet")!;
const net = args.rpc ? withOverrides(devnet, { rpcUrl: args.rpc }) : devnet;

let session: RtgsSession;
try {
  session = await connect(net, { env, ...(args.contract ? { contractId: args.contract } : {}) });
} catch (e) {
  if (e instanceof RtgsError && e.title === "No settlement contract") {
    fail(`${e.title}: ${e.detail}\nRun \`pnpm devnet:bootstrap\` first.`);
  }
  fail(`Could not connect to ${net.rpcUrl}: ${(e as Error).message}`);
}

const ids = devnetIdentities(net, args.banks);
const cb = ids.centralBank;
if (session.centralBank !== cb.address) {
  fail(
    `The contract's central bank is ${session.centralBank}, not this seed's ${cb.address}.\n` +
      "Pass the --seed the bootstrap used, or the --contract it deployed.",
  );
}
const banks = ids.banks.map((s, i) => ({ address: s.address, label: s.label ?? `Bank ${i + 1}` }));

// A deauthorized trustline is fine (recover reauthorizes it); a missing one needs the bootstrap.
try {
  const holdings = await Promise.all(banks.map((b) => session.token.holding(b.address)));
  const missing = banks.filter((_, i) => !holdings[i]!.exists);
  if (missing.length > 0) {
    fail(
      `No cash token trustline for ${missing.map((b) => `${b.label} (${b.address})`).join(", ")}.\n` +
        `Run \`pnpm devnet:bootstrap --banks ${args.banks}\` first.`,
    );
  }
} catch (e) {
  fail(`Could not read the banks' trustlines: ${(e as Error).message}`);
}

const signers = new Map(ids.banks.map((s) => [s.address, s]));
const bankActors = new Map<string, RtgsActor>();
const actors: Actors = {
  bank(address) {
    let actor = bankActors.get(address);
    if (!actor) {
      const signer = signers.get(address);
      if (!signer) throw new Error(`${address} is not one of the simulated banks`);
      actor = session.as(signer);
      bankActors.set(address, actor);
    }
    return actor;
  },
  centralBank: session.as(cb),
  tokenAdmin: session.tokenAdmin(cb),
};

const world = createWorld(session, banks);
try {
  await world.start();
} catch (e) {
  session.dispose();
  fail(`Could not read the RTGS state: ${(e as Error).message}`);
}
const policy = createPolicy({ profile: args.profile, modules: MODULES, rng: createRng(args.rngSeed), log: (m) => console.error(m) });
const reporter = createReporter({ log: args.log, summaryEvery: args.summaryEvery, reads: createReporterReads(session) });
const engine = new Engine({
  world,
  policy,
  reporter,
  actors,
  modules: MODULES,
  lanes: [...banks.map((b) => b.address), cb.address],
  rate: args.rate,
  ...(args.maxActions !== undefined ? { maxActions: args.maxActions } : {}),
});

// The first signal (or --duration) stops gracefully: drain, then recover. A second signal
// gives up on that.
let stopping: Promise<void> | undefined;
const stop = () => {
  if (!stopping) {
    console.error("Stopping: draining in-flight transactions (Ctrl-C again to force)");
    stopping = engine.stop().catch((e: unknown) => console.error(`stop failed: ${(e as Error).message}`));
  }
  return stopping;
};
let signals = 0;
const onSignal = () => {
  if (++signals > 1) process.exit(130);
  void stop();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const timer = args.duration === undefined ? undefined : setTimeout(stop, args.duration * 1000);

reporter.start({
  network: net.label,
  rpcUrl: net.rpcUrl,
  contractId: session.contractId,
  centralBank: cb.address,
  banks,
  profile: args.profile,
  rate: args.rate,
  rngSeed: args.rngSeed,
  capabilities: session.capabilities,
});

let code = 0;
try {
  await engine.run();
  // `run` also resolves on --max-actions, without a stop; and `stop` is where recover runs,
  // so wait for it (it is safe to call twice) before tearing down.
  if (stopping) await stopping;
  else await engine.stop();
} catch (e) {
  console.error(`simulate failed: ${(e as Error).message}`);
  code = 1;
} finally {
  clearTimeout(timer);
  try {
    reporter.stop();
  } finally {
    world.stop();
    session.dispose();
  }
}
process.exit(code);
