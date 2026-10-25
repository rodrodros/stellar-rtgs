// Logs, counters, periodic summaries and the conservation check. Ticket 07.
import type { RtgsSession } from "@rtgs/core";
import type { Reporter } from "../types.ts";

/** Async reads the reporter needs for its periodic summary; `createReporterReads` builds them from a session. */
export interface ReporterReads {
  /** Cash tokens the settlement contract holds (conservation: against the sum of balances). */
  contractHolding(): Promise<bigint>;
  /** An account's XLM balance in stroops, to warn before fees run out. */
  xlmBalance(address: string): Promise<bigint>;
}

export interface ReporterOptions {
  log: "pretty" | "json";
  /** Seconds between periodic summaries; 0 turns them off. */
  summaryEvery: number;
  reads: ReporterReads;
  /** Where lines go; stdout by default. */
  out?: (line: string) => void;
}

export function createReporter(_options: ReporterOptions): Reporter {
  throw new Error("createReporter: not implemented (ticket 07)");
}

export function createReporterReads(_session: RtgsSession): ReporterReads {
  throw new Error("createReporterReads: not implemented (ticket 07)");
}
