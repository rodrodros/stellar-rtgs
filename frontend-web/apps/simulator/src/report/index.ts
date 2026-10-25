// Logs, counters, periodic summaries and the conservation check. Formatting is pure (format.ts);
// this file keeps the counters, decides when a summary is due and gathers what it shows. The
// summary's reads (the contract's holding, each lane's XLM) are the only network calls here,
// and they run in the background so the engine's tick never waits on them.
import { toRtgsError, type RtgsSession } from "@rtgs/core";
import type { ActionName, Choice, Outcome, Reporter, StartInfo, Summary, WorldView } from "../types.ts";
import { txFacts } from "./events.ts";
import { formatFinal, formatResult, formatStart, formatSummary, LOW_XLM, shortAddress, totalsOf, type LogMode, type SummaryBlock } from "./format.ts";

export { txFacts, type TxFacts } from "./events.ts";
export * from "./format.ts";

/** Async reads the reporter needs for its periodic summary; `createReporterReads` builds them from a session. */
export interface ReporterReads {
  /** Cash tokens the settlement contract holds (conservation: against the sum of balances). */
  contractHolding(): Promise<bigint>;
  /** An account's XLM balance in stroops, to warn before fees run out. */
  xlmBalance(address: string): Promise<bigint>;
}

export interface ReporterOptions {
  log: LogMode;
  /** Seconds between periodic summaries; 0 turns them off. */
  summaryEvery: number;
  reads: ReporterReads;
  /** Where lines go; stdout by default. */
  out?: (line: string) => void;
  /** ANSI colour; by default only in pretty mode on a terminal. */
  color?: boolean;
}

const CENTRAL_BANK = "Central bank";

export function createReporter(options: ReporterOptions): Reporter {
  const { log: mode, reads, summaryEvery } = options;
  const out = options.out ?? ((line: string) => console.log(line));
  const color = options.color ?? (mode === "pretty" && process.stdout.isTTY === true);

  let startedAt = Date.now();
  let lastSummaryAt = startedAt;
  /** True while a summary's reads are in flight: at most one at a time. */
  let summarising = false;
  let stopped = false;
  const labels = new Map<string, string>();
  const counts: Summary["counts"] = {};
  const settlements: Summary["settlements"] = { atOnce: 0, eagerClosure: 0, offset: 0 };

  const label = (address: string) => labels.get(address) ?? shortAddress(address);
  const elapsed = () => (Date.now() - startedAt) / 1000;

  function count(name: ActionName, kind: Outcome["kind"]): void {
    const c = (counts[name] ??= { ok: 0, refused: 0, failed: 0 });
    c[kind] += 1;
  }

  async function summarise(world: WorldView): Promise<void> {
    // The lanes are the central bank and the banks the run started with.
    const lanes = [...labels.keys()];
    const [held, ...xlm] = await Promise.allSettled([reads.contractHolding(), ...lanes.map((a) => reads.xlmBalance(a))]);
    if (stopped) return;
    // Compared with the world as it is when the read returns, not when it was asked for.
    const banks = world.banks();
    const recorded = banks.reduce((sum, b) => sum + b.balance, 0n);
    const fees: SummaryBlock["fees"] = [];
    xlm.forEach((r, i) => {
      const address = lanes[i]!;
      if (r.status === "rejected") fees.push({ lane: label(address), address, error: toRtgsError(r.reason).title });
      else if (r.value < LOW_XLM) fees.push({ lane: label(address), address, xlm: r.value });
    });
    const totals = totalsOf(counts);
    const secs = elapsed();
    const block: SummaryBlock = {
      elapsed: secs,
      totals,
      actionsPerMinute: secs > 0 ? ((totals.ok + totals.refused + totals.failed) * 60) / secs : 0,
      settlements: { ...settlements },
      queuedCount: world.queuedCount(),
      queueCap: world.config().queueCap,
      banks: banks.map((b) => ({
        label: b.label,
        address: b.address,
        balance: b.balance,
        holding: b.holding,
        authorized: b.authorized,
        urgent: b.queues.urgent.length,
        normal: b.queues.normal.length,
      })),
      repos: world.repos().map((r) => ({ id: r.id, bank: world.bank(r.bank)?.label ?? label(r.bank), outstanding: r.outstanding, status: r.status })),
      conservation: held.status === "fulfilled" ? { held: held.value, recorded } : { error: toRtgsError(held.reason).title },
      fees,
    };
    out(formatSummary(block, mode, color));
  }

  return {
    start(info: StartInfo) {
      startedAt = Date.now();
      lastSummaryAt = startedAt;
      labels.clear();
      labels.set(info.centralBank, CENTRAL_BANK);
      for (const b of info.banks) labels.set(b.address, b.label);
      out(formatStart(info, mode, color));
    },

    result(choice: Choice, outcome: Outcome, ms: number) {
      count(choice.action.name, outcome.kind);
      if (outcome.kind === "ok") {
        const { settled } = txFacts(outcome.tx.events);
        settlements.atOnce += settled.atOnce.length;
        settlements.eagerClosure += settled.eagerClosure.length;
        settlements.offset += settled.offset.length;
      }
      out(formatResult({ at: new Date(), lane: label(choice.actor), choice, outcome, ms }, mode, color));
    },

    tick(world: WorldView) {
      if (stopped || summaryEvery <= 0 || summarising) return;
      const now = Date.now();
      if (now - lastSummaryAt < summaryEvery * 1000) return;
      lastSummaryAt = now;
      summarising = true;
      void summarise(world)
        .catch((e: unknown) => out(`summary failed: ${toRtgsError(e).title}`))
        .finally(() => {
          summarising = false;
        });
    },

    stop(): Summary {
      stopped = true;
      const summary: Summary = {
        elapsed: elapsed(),
        counts: structuredClone(counts),
        settlements: { ...settlements },
      };
      out(formatFinal(summary, mode, color));
      return summary;
    },
  };
}

export function createReporterReads(session: RtgsSession): ReporterReads {
  return {
    contractHolding: async () => (await session.token.holding(session.contractId)).balance,
    // The one RPC read the simulator makes itself: core has no XLM balance helper.
    xlmBalance: async (address) => {
      try {
        return (await session.server.getAccountEntry(address)).balance;
      } catch (e) {
        throw toRtgsError(e);
      }
    },
  };
}
