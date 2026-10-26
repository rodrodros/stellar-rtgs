import { allAvailable, RtgsError, type RtgsEvent, type RtgsEventBody } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { BANK_1, BANK_2, CB, CONTRACT, txOutcome, USD } from "../../test/fakes.ts";
import type { ActionDef, ActionName, Choice, Outcome } from "../types.ts";
import {
  clockTime,
  conservationLine,
  formatDuration,
  formatFinal,
  formatResult,
  formatStart,
  formatSummary,
  type ResultRecord,
  type SummaryBlock,
} from "./format.ts";

function choice(name: ActionName, params: unknown = { amount: 100n * USD }, actor = BANK_1): Choice {
  const action: ActionDef<unknown> = {
    name,
    group: "payments",
    role: "bank",
    plan: () => undefined,
    run: async () => txOutcome(undefined),
    describe: () => "100 USD to Bank 2 (urgent)",
    touches: () => [],
  };
  return { action, actor, params };
}

const event = (body: RtgsEventBody): RtgsEvent => ({ ...body, eventId: "e", ledger: 100, closedAt: 1_000, txHash: "ab", contractId: CONTRACT }) as RtgsEvent;
const submitted = (id: bigint) => event({ type: "Submitted", id, from: BANK_1, to: BANK_2, amount: 100n * USD, priority: "urgent" });
const settled = (id: bigint) => event({ type: "Settled", id, from: BANK_1, to: BANK_2, amount: 100n * USD });

const AT = new Date(2026, 9, 25, 9, 5, 7);
const record = (outcome: Outcome, name: ActionName = "submit"): ResultRecord => ({ at: AT, lane: "Bank 1", choice: choice(name), outcome, ms: 812 });
const ok = (events: RtgsEvent[] = []): Outcome => ({ kind: "ok", tx: { ...txOutcome(undefined, events), txHash: "3f2a1b9c".padEnd(64, "0") } });
const notQueued = new RtgsError("contract", "Payment order is final", "The payment order is no longer queued.", { code: 7 });

describe("formatResult, pretty", () => {
  it("prints an ok submit that settled at once, with a short hash", () => {
    const line = formatResult(record(ok([submitted(12n), settled(12n)])), "pretty");
    expect(line).toBe("09:05:07 Bank 1       submit        100 USD to Bank 2 (urgent) → ok 3f2a1b9c settled at once #12 (812 ms)");
  });

  it("prints a queued payment order, the eager closure's releases and an offset", () => {
    expect(formatResult(record(ok([submitted(12n)])), "pretty")).toContain("ok 3f2a1b9c queued #12 (812 ms)");
    const closure = formatResult(record(ok([event({ type: "Deposited", bank: BANK_1, amount: USD }), settled(3n), settled(5n)]), "deposit"), "pretty");
    expect(closure).toContain("eager closure released #3 #5");
    const offset = formatResult(record(ok([submitted(5n), event({ type: "Offset", ids: [4n, 5n] }), settled(4n), settled(5n)])), "pretty");
    expect(offset).toContain("ok 3f2a1b9c offset #4 #5 (812 ms)");
    expect(offset).not.toContain("at once");
  });

  it("prints repos opened and repaid", () => {
    const opened = formatResult(record(ok([event({ type: "RepoOpened", id: 7n, bank: BANK_1, amount: 300n * USD })]), "openRepo"), "pretty");
    expect(opened).toContain("repo #7 opened for 300");
    const part = formatResult(record(ok([event({ type: "RepoRepaid", id: 7n, amount: 100n * USD, outstanding: 200n * USD })]), "repay"), "pretty");
    expect(part).toContain("repo #7 repaid 100, 200 outstanding");
    const full = formatResult(record(ok([event({ type: "RepoRepaid", id: 7n, amount: 200n * USD, outstanding: 0n })]), "repay"), "pretty");
    expect(full).toContain("repo #7 repaid 200, in full");
  });

  it("prints revocations and reprioritisations", () => {
    const line = formatResult(record(ok([event({ type: "Revoked", id: 3n }), event({ type: "Reprioritised", id: 4n, priority: "urgent" })]), "revoke"), "pretty");
    expect(line).toContain("ok 3f2a1b9c revoked #3; #4 now urgent (812 ms)");
    const json = JSON.parse(formatResult(record(ok([event({ type: "Revoked", id: 3n }), event({ type: "Reprioritised", id: 4n, priority: "urgent" })]), "revoke"), "json"));
    expect(json).toMatchObject({ revoked: ["3"], reprioritised: [{ id: "4", priority: "urgent" }] });
  });

  it("prints just ok and the hash when the transaction has no contract events", () => {
    expect(formatResult(record(ok(), "issue"), "pretty")).toMatch(/issue +100 USD to Bank 2 \(urgent\) → ok 3f2a1b9c \(812 ms\)$/);
  });

  it("prints a refusal and a failure with the error's title", () => {
    expect(formatResult(record({ kind: "refused", error: notQueued }, "revoke"), "pretty")).toMatch(/revoke .* → refused: Payment order is final \(812 ms\)$/);
    const failed = formatResult(record({ kind: "failed", error: new RtgsError("rpc", "Network unreachable", "fetch failed") }), "pretty");
    expect(failed).toContain("→ FAILED: Network unreachable fetch failed (812 ms)");
  });

  it("colours only when asked", () => {
    expect(formatResult(record(ok()), "pretty")).not.toContain("\x1b[");
    expect(formatResult(record(ok()), "pretty", true)).toContain("\x1b[32mok\x1b[0m");
    expect(formatResult(record({ kind: "refused", error: notQueued }), "pretty", true)).toContain("\x1b[33mrefused");
  });

  it("survives a describe that throws", () => {
    const c = choice("submit");
    c.action.describe = () => {
      throw new Error("bad params");
    };
    expect(formatResult({ ...record(ok()), choice: c }, "pretty")).toContain("submit");
  });
});

describe("formatResult, JSON", () => {
  it("prints one object with the facts as fields and bigints as strings", () => {
    const line = formatResult(record(ok([submitted(5n), event({ type: "Offset", ids: [4n, 5n] }), settled(4n), settled(5n)])), "json");
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "result",
      at: AT.toISOString(),
      lane: "Bank 1",
      actor: BANK_1,
      action: "submit",
      group: "payments",
      description: "100 USD to Bank 2 (urgent)",
      params: { amount: "1000000000" },
      outcome: "ok",
      ms: 812,
      txHash: "3f2a1b9c".padEnd(64, "0"),
      ledger: 100,
      settled: { atOnce: [], eagerClosure: [], offset: ["4", "5"] },
      offsets: [["4", "5"]],
    });
  });

  it("carries queued ids and repos only when there are some", () => {
    const queued = JSON.parse(formatResult(record(ok([submitted(9n)])), "json"));
    expect(queued.queued).toEqual(["9"]);
    expect(queued.repos).toBeUndefined();
    const repo = JSON.parse(formatResult(record(ok([event({ type: "RepoOpened", id: 7n, bank: BANK_1, amount: 3n })]), "openRepo"), "json"));
    expect(repo.repos.opened).toEqual([{ id: "7", bank: BANK_1, amount: "3" }]);
    expect(repo.queued).toBeUndefined();
  });

  it("prints a refusal or failure with its error", () => {
    const line = JSON.parse(formatResult(record({ kind: "refused", error: notQueued }, "revoke"), "json"));
    expect(line).toMatchObject({ outcome: "refused", error: { kind: "contract", code: 7, title: "Payment order is final" } });
    expect(line.txHash).toBeUndefined();
    const failed = JSON.parse(formatResult(record({ kind: "failed", error: new RtgsError("rpc", "Network unreachable", "x") }), "json"));
    expect(failed.error).toEqual({ kind: "rpc", title: "Network unreachable", detail: "x" });
  });

  it("never colours", () => {
    expect(formatResult(record(ok()), "json", true)).not.toContain("\x1b[");
  });
});

describe("formatStart", () => {
  const info = {
    network: "devnet",
    rpcUrl: "http://localhost:8000/rpc",
    contractId: CONTRACT,
    centralBank: CB,
    banks: [
      { address: BANK_1, label: "Bank 1" },
      { address: BANK_2, label: "Bank 2" },
    ],
    profile: "balanced",
    rate: 2,
    rngSeed: 42,
    capabilities: allAvailable(),
  };

  it("prints the network, the lanes, the profile and the seed", () => {
    const text = formatStart(info, "pretty");
    for (const s of ["devnet", "http://localhost:8000/rpc", CONTRACT, CB, `Bank 1   ${BANK_1}`, `Bank 2   ${BANK_2}`, "balanced · 2 actions/s · rng seed 42", "all available"]) {
      expect(text).toContain(s);
    }
  });

  it("lists only the capabilities that aren't available", () => {
    const text = formatStart({ ...info, capabilities: { ...allAvailable(), credit: "stub", repo: "unknown" } }, "pretty");
    expect(text).toContain("not available: credit (stub), repo (unknown)");
    expect(JSON.parse(formatStart({ ...info, capabilities: { ...allAvailable(), credit: "stub" } }, "json"))).toMatchObject({
      type: "start",
      rngSeed: 42,
      unavailable: { credit: "stub" },
    });
  });
});

const block = (over: Partial<SummaryBlock> = {}): SummaryBlock => ({
  elapsed: 330,
  totals: { ok: 200, refused: 3, failed: 0 },
  actionsPerMinute: 36.909,
  settlements: { atOnce: 120, eagerClosure: 30, offset: 6 },
  queuedCount: 3,
  queueCap: 16,
  banks: [
    { label: "Bank 1", address: BANK_1, balance: 1_000n * USD, holding: 5_000n * USD, authorized: true, urgent: 0, normal: 2 },
    { label: "Bank 2", address: BANK_2, balance: 2_000n * USD, holding: 50n * USD, authorized: false, urgent: 1, normal: 0 },
  ],
  repos: [{ id: 0n, bank: "Bank 1", outstanding: 200n * USD, status: "intraday" }],
  conservation: { held: 3_000n * USD, recorded: 3_000n * USD },
  fees: [],
  ...over,
});

describe("formatSummary", () => {
  it("prints the run's pace, the queue, every bank and the repos", () => {
    const text = formatSummary(block(), "pretty");
    expect(text).toContain("── 5m 30s · 36.9 actions/min · ok 200 · refused 3 · failed 0 ──");
    expect(text).toContain("queue: 3 / 16");
    expect(text).toContain("settlements: at once 120 · eager closure 30 · offset 6");
    expect(text).toContain("bank    balance  holding  authorized  urgent  normal");
    expect(text).toContain("Bank 1     1000     5000  yes              0       2");
    expect(text).toContain("Bank 2     2000       50  no               1       0");
    expect(text).toContain("repos: 1 outstanding, 200 in all: #0 Bank 1 200 (intraday)");
    expect(text).toContain("conservation: held 3000 = recorded 3000 ✓");
    expect(formatSummary(block({ repos: [] }), "pretty")).toContain("repos: none outstanding");
  });

  it("warns loudly when the contract's holding isn't the sum of balances", () => {
    const text = formatSummary(block({ conservation: { held: 3_000n * USD, recorded: 2_900n * USD } }), "pretty");
    expect(text).toContain("!!! CONSERVATION BROKEN: the contract holds 3000 but the settlement balances sum to 2900 (held − recorded = +100)");
    expect(text).not.toContain("✓");
    expect(conservationLine({ held: 1n, recorded: 3n })).toContain("held − recorded = -0.0000002");
    expect(conservationLine({ held: 1n, recorded: 3n }, true)).toMatch(/^\x1b\[31m!!!/);
    const json = JSON.parse(formatSummary(block({ conservation: { held: 30n, recorded: 29n } }), "json"));
    expect(json.conservation).toEqual({ held: "30", recorded: "29", ok: false, difference: "1" });
  });

  it("says when the contract's holding couldn't be read", () => {
    expect(formatSummary(block({ conservation: { error: "Network unreachable" } }), "pretty")).toContain(
      "conservation: couldn't read the contract's holding (Network unreachable)",
    );
  });

  it("warns about lanes low on XLM, or whose XLM couldn't be read", () => {
    const text = formatSummary(
      block({
        fees: [
          { lane: "Bank 2", address: BANK_2, xlm: 87n * 10_000_000n },
          { lane: "Central bank", address: CB, error: "Network unreachable" },
        ],
      }),
      "pretty",
    );
    expect(text).toContain("!!! LOW XLM: Bank 2 has 87 XLM, below 100; refuelling is off or failing, so its fees will run out");
    expect(text).toContain("fees: couldn't read Central bank's XLM (Network unreachable)");
    expect(formatSummary(block(), "pretty")).not.toContain("XLM");
  });

  it("prints JSON on one line, bigints as strings", () => {
    const line = formatSummary(block(), "json");
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({
      type: "summary",
      elapsed: 330,
      actionsPerMinute: 36.9,
      queuedCount: 3,
      queueCap: 16,
      banks: [{ label: "Bank 1", balance: "10000000000", authorized: true }, { authorized: false }],
      conservation: { ok: true, difference: "0" },
      fees: [],
    });
  });
});

describe("formatFinal", () => {
  const summary = {
    elapsed: 3725,
    counts: { submit: { ok: 10, refused: 1, failed: 0 }, deposit: { ok: 4, refused: 0, failed: 2 } },
    settlements: { atOnce: 5, eagerClosure: 3, offset: 2 },
  };

  it("prints counts per action, in the actions' order, with totals", () => {
    const lines = formatFinal(summary, "pretty").split("\n");
    expect(lines[0]).toBe("── simulation stopped after 1h 02m 05s ──");
    expect(lines.slice(1, 5)).toEqual([
      "action   ok  refused  failed",
      "deposit   4        0       2",
      "submit   10        1       0",
      "total    14        1       2",
    ]);
    expect(lines[5]).toBe("settlements: at once 5 · eager closure 3 · offset 2");
  });

  it("prints JSON", () => {
    expect(JSON.parse(formatFinal(summary, "json"))).toEqual({ type: "final", ...summary });
  });
});

describe("helpers", () => {
  it("formats durations and clock times", () => {
    expect([formatDuration(0), formatDuration(42.9), formatDuration(75), formatDuration(3725)]).toEqual(["0s", "42s", "1m 15s", "1h 02m 05s"]);
    expect(clockTime(AT)).toBe("09:05:07");
  });
});
