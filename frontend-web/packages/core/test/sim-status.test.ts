import { describe, expect, it } from "vitest";
import { overdueRepos, termEndOf } from "../src/model/repos.ts";
import { loadNetworks } from "../src/network/networks.ts";
import { formatSimStatus, parseSimStatus, publishSimStatus, SIM_STATUS_KEY } from "../src/registry/ledger.ts";
import { devnetIdentities } from "../src/signer/keypair.ts";
import type { TxContext } from "../src/tx.ts";
import type { Config, Repo } from "../src/types.ts";
import { A, CB } from "./helpers.ts";

const [devnet] = loadNetworks({});

describe("simulation status", () => {
  it("round-trips through its stored form", () => {
    for (const state of ["running", "stopping", "stopped"] as const) {
      const status = { state, at: 1_792_971_603 };
      expect(parseSimStatus(formatSimStatus(status))).toEqual(status);
    }
    expect(formatSimStatus({ state: "running", at: 1_792_971_603 })).toBe("running:1792971603");
  });

  it("reads anything else as no status", () => {
    for (const value of [undefined, "", "running", "paused:1", "running:", "running:12x", "RUNNING:1"]) {
      expect(parseSimStatus(value)).toBeUndefined();
    }
  });

  it("fits the 64-byte data entry limits", () => {
    expect(Buffer.byteLength(SIM_STATUS_KEY)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(formatSimStatus({ state: "stopping", at: Number.MAX_SAFE_INTEGER }))).toBeLessThanOrEqual(64);
  });

  it("refuses a signer that isn't the central bank", () => {
    const bank = devnetIdentities(devnet!, 1).banks[0]!;
    expect(() => publishSimStatus({} as TxContext, bank, CB, { state: "running", at: 1 })).toThrow(/central bank/);
  });
});

describe("overdue repos", () => {
  const config = { repoTermSecs: 100 } as Config;
  const repo = (id: bigint, openedAt: number, status: Repo["status"] = "intraday"): Repo => ({
    id,
    bank: A,
    amount: 1n,
    outstanding: 1n,
    openedAt,
    status,
    rateBps: 0,
  });

  it("lists intraday repos strictly past their term, oldest first", () => {
    const repos = [repo(3n, 900), repo(0n, 900), repo(1n, 950), repo(2n, 0, "penalty")];
    expect(termEndOf(repos[0]!, config)).toBe(1000);
    expect(overdueRepos(repos, config, 1000)).toEqual([]);
    expect(overdueRepos(repos, config, 1001).map((r) => r.id)).toEqual([0n, 3n]);
  });
});
