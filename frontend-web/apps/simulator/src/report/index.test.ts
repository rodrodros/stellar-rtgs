import { allAvailable, RtgsError, type RtgsEvent, type RtgsEventBody } from "@rtgs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BANK_1, BANK_2, BANK_3, bank, CB, CONTRACT, fakeWorld, txOutcome, USD } from "../../test/fakes.ts";
import type { ActionDef, ActionName, Choice, Outcome, StartInfo } from "../types.ts";
import { createReporter, LOW_XLM, type ReporterReads } from "./index.ts";

function choice(name: ActionName, actor = BANK_1): Choice {
  const action: ActionDef<unknown> = {
    name,
    group: "payments",
    role: "bank",
    plan: () => undefined,
    run: async () => txOutcome(undefined),
    describe: () => "something",
    touches: () => [],
  };
  return { action, actor, params: {} };
}

const event = (body: RtgsEventBody): RtgsEvent => ({ ...body, eventId: "e", ledger: 100, closedAt: 1_000, txHash: "ab", contractId: CONTRACT }) as RtgsEvent;
const submitted = (id: bigint) => event({ type: "Submitted", id, from: BANK_1, to: BANK_2, amount: USD, priority: "normal" });
const settled = (id: bigint) => event({ type: "Settled", id, from: BANK_1, to: BANK_2, amount: USD });
const ok = (events: RtgsEvent[] = []): Outcome => ({ kind: "ok", tx: txOutcome(undefined, events) });
const refused: Outcome = { kind: "refused", error: new RtgsError("contract", "Payment order is final", "", { code: 7 }) };
const failed: Outcome = { kind: "failed", error: new RtgsError("rpc", "Network unreachable", "") };

const INFO: StartInfo = {
  network: "devnet",
  rpcUrl: "http://localhost:8000/rpc",
  contractId: CONTRACT,
  centralBank: CB,
  banks: [BANK_1, BANK_2, BANK_3].map((address) => ({ address, label: `Bank ${address.slice(-1)}` })),
  profile: "balanced",
  rate: 2,
  rngSeed: 42,
  capabilities: allAvailable(),
};

/** The three fake banks hold 1000 USD each. */
const BALANCES = 3_000n * USD;
const PLENTY_XLM = 10_000n * 10_000_000n;

function setup(over: { reads?: Partial<ReporterReads>; summaryEvery?: number; log?: "pretty" | "json" } = {}) {
  const lines: string[] = [];
  const reads: ReporterReads = {
    conservation: vi.fn(async () => ({ held: BALANCES, recorded: BALANCES })),
    xlmBalance: vi.fn(async () => PLENTY_XLM),
    ...over.reads,
  };
  const reporter = createReporter({ log: over.log ?? "pretty", summaryEvery: over.summaryEvery ?? 30, reads, out: (l) => lines.push(l) });
  return { reporter, reads, lines, world: fakeWorld() };
}

/** Lets the summary's background reads resolve. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 25, 9, 0, 0));
});
afterEach(() => vi.useRealTimers());

describe("createReporter", () => {
  it("prints the header on start and one line per result, labelled by lane", () => {
    const { reporter, lines } = setup();
    reporter.start(INFO);
    expect(lines[0]).toContain("RTGS simulation on devnet");
    reporter.result(choice("submit", BANK_2), ok(), 5);
    reporter.result(choice("issue", CB), ok(), 5);
    reporter.result(choice("issue", "GUNKNOWNADDRESS1234"), ok(), 5);
    expect(lines[1]).toContain(" Bank 2       submit ");
    expect(lines[2]).toContain(" Central bank issue ");
    expect(lines[3]).toContain(" GUNKN…1234   issue ");
  });

  it("counts results per action and outcome, and settlements by kind from ok transactions only", () => {
    const { reporter } = setup();
    reporter.start(INFO);
    reporter.result(choice("submit"), ok([submitted(1n), settled(1n)]), 5);
    reporter.result(choice("submit"), ok([submitted(2n)]), 5);
    reporter.result(choice("deposit"), ok([settled(2n), settled(0n)]), 5);
    reporter.result(choice("submit"), ok([submitted(3n), event({ type: "Offset", ids: [3n, 0n] }), settled(3n), settled(0n)]), 5);
    reporter.result(choice("revoke"), refused, 5);
    reporter.result(choice("revoke"), failed, 5);
    reporter.result(choice("revoke"), refused, 5);
    vi.advanceTimersByTime(90_000);
    const summary = reporter.stop();
    expect(summary).toEqual({
      elapsed: 90,
      counts: {
        submit: { ok: 3, refused: 0, failed: 0 },
        deposit: { ok: 1, refused: 0, failed: 0 },
        revoke: { ok: 0, refused: 2, failed: 1 },
      },
      settlements: { atOnce: 1, eagerClosure: 2, offset: 2 },
    });
  });

  it("prints the final summary on stop, and returns a copy the reporter won't change", () => {
    const { reporter, lines } = setup();
    reporter.start(INFO);
    reporter.result(choice("submit"), ok(), 5);
    const summary = reporter.stop();
    expect(lines.at(-1)).toContain("simulation stopped after 0s");
    reporter.result(choice("submit"), ok(), 5);
    expect(summary.counts.submit).toEqual({ ok: 1, refused: 0, failed: 0 });
  });

  it("prints JSON lines in JSON mode", () => {
    const { reporter, lines } = setup({ log: "json" });
    reporter.start(INFO);
    reporter.result(choice("submit"), ok([submitted(1n)]), 5);
    reporter.stop();
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["start", "result", "final"]);
    expect(JSON.parse(lines[1]!).queued).toEqual(["1"]);
  });
});

describe("periodic summary", () => {
  it("prints every summaryEvery seconds of wall clock, however often the engine ticks", async () => {
    const { reporter, lines, world, reads } = setup({ summaryEvery: 30 });
    reporter.start(INFO);
    const summaries = () => lines.filter((l) => l.startsWith("── ")).length;
    for (let s = 0; s < 29; s++) {
      vi.advanceTimersByTime(1_000);
      reporter.tick(world);
    }
    await flush();
    expect(summaries()).toBe(0);
    vi.advanceTimersByTime(1_000);
    reporter.tick(world);
    reporter.tick(world);
    await flush();
    expect(summaries()).toBe(1);
    expect(reads.conservation).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    reporter.tick(world);
    await flush();
    expect(summaries()).toBe(2);
  });

  it("is off when summaryEvery is 0", async () => {
    const { reporter, lines, world, reads } = setup({ summaryEvery: 0 });
    reporter.start(INFO);
    vi.advanceTimersByTime(3_600_000);
    reporter.tick(world);
    await flush();
    expect(lines).toHaveLength(1);
    expect(reads.conservation).not.toHaveBeenCalled();
  });

  it("doesn't block tick, and doesn't read again while a read is slow", async () => {
    let resolve!: (v: { held: bigint; recorded: bigint }) => void;
    const conservation = vi.fn(() => new Promise<{ held: bigint; recorded: bigint }>((r) => (resolve = r)));
    const { reporter, lines, world } = setup({ summaryEvery: 10, reads: { conservation } });
    reporter.start(INFO);
    vi.advanceTimersByTime(10_000);
    expect(reporter.tick(world)).toBeUndefined();
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(1_000);
      reporter.tick(world);
    }
    await flush();
    expect(conservation).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    resolve({ held: BALANCES, recorded: BALANCES });
    await flush();
    expect(lines.at(-1)).toContain("held 3000 = recorded 3000 ✓");
    vi.advanceTimersByTime(10_000);
    reporter.tick(world);
    expect(conservation).toHaveBeenCalledTimes(2);
  });

  it("shows the run's pace, the queue, the banks and the repos", async () => {
    const { reporter, lines, world } = setup({ summaryEvery: 60 });
    world.state.banks[1] = bank(BANK_2, { authorized: false, balance: 1_000n * USD });
    world.state.repos = [{ id: 4n, bank: BANK_1, amount: 50n * USD, outstanding: 20n * USD, openedAt: 1_000, status: "intraday", rateBps: 0 }];
    world.state.queuedCount = 5;
    reporter.start(INFO);
    for (let i = 0; i < 30; i++) reporter.result(choice("submit"), ok(), 5);
    vi.advanceTimersByTime(60_000);
    reporter.tick(world);
    await flush();
    const text = lines.at(-1)!;
    expect(text).toContain("── 1m 00s · 30 actions/min · ok 30 · refused 0 · failed 0 ──");
    expect(text).toContain("queue: 5 / 16");
    expect(text).toMatch(/Bank 2 +1000 +5000 +no/);
    expect(text).toContain("#4 Bank 1 20 (intraday)");
  });

  it("warns loudly when the contract holds other than the sum of balances", async () => {
    const { reporter, lines, world } = setup({ reads: { conservation: async () => ({ held: BALANCES - 7n * USD, recorded: BALANCES }) } });
    reporter.start(INFO);
    vi.advanceTimersByTime(30_000);
    reporter.tick(world);
    await flush();
    expect(lines.at(-1)).toContain("!!! CONSERVATION BROKEN: the contract holds 2993 but the settlement balances sum to 3000 (held − recorded = -7)");
  });

  it("reads every bank, the central bank and the contract in one conservation read", async () => {
    const { reporter, world, reads } = setup();
    reporter.start(INFO);
    vi.advanceTimersByTime(30_000);
    reporter.tick(world);
    await flush();
    const accounts = (reads.conservation as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(new Set(accounts)).toEqual(new Set([BANK_1, BANK_2, BANK_3, CB, CONTRACT]));
  });

  it("says so when the holding can't be read, and keeps going", async () => {
    const conservation = vi.fn().mockRejectedValueOnce(new RtgsError("rpc", "Network unreachable", "")).mockResolvedValue({ held: BALANCES, recorded: BALANCES });
    const { reporter, lines, world } = setup({ reads: { conservation } });
    reporter.start(INFO);
    vi.advanceTimersByTime(30_000);
    reporter.tick(world);
    await flush();
    expect(lines.at(-1)).toContain("couldn't read the contract's holding (Network unreachable)");
    vi.advanceTimersByTime(30_000);
    reporter.tick(world);
    await flush();
    expect(lines.at(-1)).toContain("✓");
  });

  it("gives up on a read that never returns, so later summaries still print", async () => {
    const conservation = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue({ held: BALANCES, recorded: BALANCES });
    const { reporter, lines, world } = setup({ summaryEvery: 30, reads: { conservation } });
    reporter.start(INFO);
    vi.advanceTimersByTime(30_000);
    reporter.tick(world);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.at(-1)).toContain("couldn't read the contract's holding (Timed out)");
    reporter.tick(world);
    await flush();
    expect(lines.at(-1)).toContain("✓");
  });

  it("warns about every lane, central bank included, below 100 XLM", async () => {
    const xlmBalance = vi.fn(async (a: string) => (a === BANK_3 || a === CB ? LOW_XLM - 1n : LOW_XLM));
    const { reporter, lines, world } = setup({ reads: { xlmBalance } });
    reporter.start(INFO);
    vi.advanceTimersByTime(30_000);
    reporter.tick(world);
    await flush();
    expect(xlmBalance.mock.calls.map(([a]) => a).sort()).toEqual([BANK_1, BANK_2, BANK_3, CB].sort());
    const text = lines.at(-1)!;
    expect(text).toContain("!!! LOW XLM: Bank 3 has 99.9999999 XLM");
    expect(text).toContain("!!! LOW XLM: Central bank has 99.9999999 XLM");
    expect(text).not.toContain("LOW XLM: Bank 1");
  });

  it("drops a summary whose reads return after stop", async () => {
    let resolve!: (v: { held: bigint; recorded: bigint }) => void;
    const { reporter, lines, world } = setup({ reads: { conservation: () => new Promise((r) => (resolve = r)) } });
    reporter.start(INFO);
    vi.advanceTimersByTime(30_000);
    reporter.tick(world);
    reporter.stop();
    resolve({ held: BALANCES, recorded: BALANCES });
    await flush();
    expect(lines.at(-1)).toContain("simulation stopped");
  });
});
