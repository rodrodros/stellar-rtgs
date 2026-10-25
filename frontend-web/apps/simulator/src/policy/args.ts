// `pnpm simulate` flags: parsing and validation as pure functions, so cli.ts only wires.
import { parseArgs } from "node:util";
import { PROFILE_NAMES, type ProfileName } from "./profiles.ts";

export interface CliArgs {
  rpc?: string;
  /** The devnet seed identities derive from; else `RTGS_DEVNET_SEED` or the default. */
  seed?: string;
  banks: number;
  contract?: string;
  profile: ProfileName;
  /** Actions per second, across all lanes. */
  rate: number;
  rngSeed: number;
  maxActions?: number;
  /** Seconds before stopping by itself. */
  duration?: number;
  log: "pretty" | "json";
  /** Seconds between periodic summaries; 0 turns them off. */
  summaryEvery: number;
}

export type ParsedArgs = { kind: "run"; args: CliArgs } | { kind: "help" } | { kind: "error"; message: string };

export const USAGE = `pnpm simulate [flags]

Keeps the bootstrapped devnet's banks transacting until Ctrl-C.

  --rpc <url>            devnet RPC (default: RTGS_DEVNET_RPC_URL, else http://localhost:8300/rpc)
  --seed <seed>          devnet identity seed, as given to the bootstrap
  --banks <n>            banks bank-1..n to drive (default 3)
  --contract <id>        settlement contract (default: discovered from the central bank)
  --profile <name>       ${PROFILE_NAMES.join(" | ")} (default balanced)
  --rate <n>             actions per second, across all lanes (default 2)
  --rng-seed <n>         repeat a run's choices (default random, printed at start)
  --max-actions <n>      stop after n actions
  --duration <secs>      stop after this many seconds
  --log <format>         pretty | json (default pretty)
  --summary-every <secs> seconds between summaries, 0 for none (default 30)
  --help                 show this help`;

/** Parses argv (without node and the script); `randomSeed` supplies `--rng-seed`'s default. */
export function parseCliArgs(argv: readonly string[], randomSeed: () => number = defaultRandomSeed): ParsedArgs {
  // The root script is `pnpm --filter … start --`, so tsx gets one separator before the flags,
  // or two after `pnpm simulate -- --rate 5`.
  let skip = 0;
  while (argv[skip] === "--") skip++;
  const args = argv.slice(skip);
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        rpc: { type: "string" },
        seed: { type: "string" },
        banks: { type: "string", default: "3" },
        contract: { type: "string" },
        profile: { type: "string", default: "balanced" },
        rate: { type: "string", default: "2" },
        "rng-seed": { type: "string" },
        "max-actions": { type: "string" },
        duration: { type: "string" },
        log: { type: "string", default: "pretty" },
        "summary-every": { type: "string", default: "30" },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help" };

  try {
    const profile = values.profile;
    if (!PROFILE_NAMES.includes(profile as ProfileName)) {
      throw new ArgError(`--profile must be one of ${PROFILE_NAMES.join(", ")}, not "${profile}"`);
    }
    if (values.log !== "pretty" && values.log !== "json") throw new ArgError(`--log must be pretty or json, not "${values.log}"`);
    for (const flag of ["rpc", "seed", "contract"] as const) {
      if (values[flag]?.trim() === "") throw new ArgError(`--${flag} must not be empty`);
    }
    const parsed: CliArgs = {
      banks: integer("--banks", values.banks, 2),
      profile: profile as ProfileName,
      rate: positive("--rate", values.rate),
      rngSeed: values["rng-seed"] === undefined ? randomSeed() : integer("--rng-seed", values["rng-seed"], 0, 2 ** 32 - 1),
      log: values.log,
      summaryEvery: nonNegative("--summary-every", values["summary-every"]),
    };
    if (values.rpc !== undefined) parsed.rpc = values.rpc;
    if (values.seed !== undefined) parsed.seed = values.seed;
    if (values.contract !== undefined) parsed.contract = values.contract;
    if (values["max-actions"] !== undefined) parsed.maxActions = integer("--max-actions", values["max-actions"], 1);
    if (values.duration !== undefined) parsed.duration = positive("--duration", values.duration);
    return { kind: "run", args: parsed };
  } catch (e) {
    if (e instanceof ArgError) return { kind: "error", message: e.message };
    throw e;
  }
}

class ArgError extends Error {}

function defaultRandomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

function number(flag: string, text: string): number {
  const n = Number(text);
  if (text.trim() === "" || !Number.isFinite(n)) throw new ArgError(`${flag} must be a number, not "${text}"`);
  return n;
}

function integer(flag: string, text: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = number(flag, text);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ArgError(`${flag} must be a whole number${max === Number.MAX_SAFE_INTEGER ? ` of at least ${min}` : ` from ${min} to ${max}`}, not "${text}"`);
  }
  return n;
}

function positive(flag: string, text: string): number {
  const n = number(flag, text);
  if (n <= 0) throw new ArgError(`${flag} must be greater than 0, not "${text}"`);
  return n;
}

function nonNegative(flag: string, text: string): number {
  const n = number(flag, text);
  if (n < 0) throw new ArgError(`${flag} must be 0 or more, not "${text}"`);
  return n;
}
