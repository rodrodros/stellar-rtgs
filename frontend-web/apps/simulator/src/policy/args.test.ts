import { describe, expect, it } from "vitest";
import { parseCliArgs, type CliArgs } from "./args.ts";

const run = (argv: string[]): CliArgs => {
  const parsed = parseCliArgs(argv, () => 1234);
  if (parsed.kind !== "run") throw new Error(`expected run, got ${JSON.stringify(parsed)}`);
  return parsed.args;
};
const error = (argv: string[]): string => {
  const parsed = parseCliArgs(argv, () => 1234);
  if (parsed.kind !== "error") throw new Error(`expected an error, got ${JSON.stringify(parsed)}`);
  return parsed.message;
};

describe("parseCliArgs", () => {
  it("defaults, with a random rng seed", () => {
    expect(run([])).toEqual({ banks: 3, profile: "balanced", rate: 2, rngSeed: 1234, log: "pretty", summaryEvery: 30 });
  });

  it("reads every flag", () => {
    expect(
      run([
        "--rpc", "http://localhost:8400/rpc",
        "--seed", "s",
        "--banks", "5",
        "--contract", "CABC",
        "--profile", "gridlock",
        "--rate", "0.5",
        "--rng-seed", "42",
        "--max-actions", "100",
        "--duration", "60",
        "--log", "json",
        "--summary-every", "0",
      ]),
    ).toEqual({
      rpc: "http://localhost:8400/rpc",
      seed: "s",
      banks: 5,
      contract: "CABC",
      profile: "gridlock",
      rate: 0.5,
      rngSeed: 42,
      maxActions: 100,
      duration: 60,
      log: "json",
      summaryEvery: 0,
    });
  });

  it("skips the separator pnpm passes through", () => {
    expect(run(["--", "--rate", "5"]).rate).toBe(5);
  });

  it("asks for help", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--rate", "nope", "--help"])).toEqual({ kind: "help" });
  });

  it("refuses unknown flags and positionals", () => {
    expect(error(["--fast"])).toMatch(/fast/);
    expect(error(["extra"])).toMatch(/extra/);
  });

  it("validates values", () => {
    expect(error(["--profile", "chaos"])).toBe('--profile must be one of balanced, gridlock, calm, not "chaos"');
    expect(error(["--log", "xml"])).toBe('--log must be pretty or json, not "xml"');
    expect(error(["--banks", "1"])).toBe('--banks must be a whole number of at least 2, not "1"');
    expect(error(["--banks", "2.5"])).toMatch(/--banks must be a whole number/);
    expect(error(["--rate", "0"])).toBe('--rate must be greater than 0, not "0"');
    expect(error(["--rate", "fast"])).toBe('--rate must be a number, not "fast"');
    expect(error(["--rng-seed=-1"])).toBe('--rng-seed must be a whole number from 0 to 4294967295, not "-1"');
    expect(error(["--max-actions", "0"])).toMatch(/--max-actions must be a whole number of at least 1/);
    expect(error(["--duration=-5"])).toBe('--duration must be greater than 0, not "-5"');
    expect(error(["--summary-every=-1"])).toBe('--summary-every must be 0 or more, not "-1"');
    expect(error(["--banks", ""])).toBe('--banks must be a number, not ""');
  });

  it("needs a value for string flags", () => {
    expect(error(["--rate"])).toMatch(/rate/);
  });
});
