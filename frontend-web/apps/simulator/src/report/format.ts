// Pure formatting: every line the reporter prints, built from plain data, so each can be tested
// without a clock, a terminal or a network. Pretty mode is for people (columns, optional ANSI
// colour); JSON mode is one object per line for tools, with bigints as strings.
import { formatAmount, type Capability, type EntryPoint } from "@rtgs/core";
import type { ActionName, Choice, Outcome, StartInfo, Summary } from "../types.ts";
import { txFacts, type TxFacts } from "./events.ts";

export type LogMode = "pretty" | "json";

/** Every action, in the order summaries list them. */
export const ACTION_NAMES: readonly ActionName[] = [
  "deposit",
  "withdraw",
  "submit",
  "revoke",
  "reprioritise",
  "setCollateral",
  "openRepo",
  "repay",
  "issue",
  "clawback",
  "deauthorize",
  "reauthorize",
];

export interface Tally {
  ok: number;
  refused: number;
  failed: number;
}

/** One action's result, as `formatResult` prints it. */
export interface ResultRecord {
  at: Date;
  /** The lane's label, e.g. "Bank 1". */
  lane: string;
  choice: Choice;
  outcome: Outcome;
  ms: number;
}

/** What a periodic summary shows; the reporter gathers it from the world and its reads. */
export interface SummaryBlock {
  /** Seconds since the run started. */
  elapsed: number;
  totals: Tally;
  actionsPerMinute: number;
  settlements: Summary["settlements"];
  queuedCount: number;
  queueCap: number;
  banks: {
    label: string;
    address: string;
    balance: bigint;
    holding: bigint;
    authorized: boolean;
    urgent: number;
    normal: number;
  }[];
  repos: { id: bigint; bank: string; outstanding: bigint; status: string }[];
  /** The contract's cash token holding against the sum of settlement balances, or why it wasn't read. */
  conservation: { held: bigint; recorded: bigint } | { error: string };
  /** Lanes whose XLM is below the threshold, or couldn't be read. */
  fees: { lane: string; address: string; xlm?: bigint; error?: string }[];
}

/** 100 XLM, in stroops: below it a lane is warned that its fees will run out. */
export const LOW_XLM = 100n * 10_000_000n;

const ANSI = { red: 31, green: 32, yellow: 33, dim: 2, bold: 1 } as const;
type Paint = (style: keyof typeof ANSI, text: string) => string;
const painter =
  (color: boolean): Paint =>
  (style, text) =>
    color ? `\x1b[${ANSI[style]}m${text}\x1b[0m` : text;

/** `JSON.stringify` with bigints as strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/** Local wall-clock time, "HH:MM:SS". */
export function clockTime(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** 75 -> "1m 15s", 3725 -> "1h 02m 05s". */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(rest).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

/** "GABCD…WXYZ", for an address with no label. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-4)}` : address;
}

const ids = (xs: readonly bigint[]) => xs.map((id) => `#${id}`).join(" ");

/** What happened, in words: "settled at once #12", "eager closure released #3 #5", ... */
export function describeFacts(facts: TxFacts): string[] {
  const parts: string[] = [];
  const { atOnce, eagerClosure } = facts.settled;
  if (atOnce.length) parts.push(`settled at once ${ids(atOnce)}`);
  if (facts.queued.length) parts.push(`queued ${ids(facts.queued)}`);
  if (eagerClosure.length) parts.push(`eager closure released ${ids(eagerClosure)}`);
  for (const offset of facts.offsets) parts.push(`offset ${ids(offset)}`);
  for (const r of facts.repos.opened) parts.push(`repo #${r.id} opened for ${formatAmount(r.amount)}`);
  for (const r of facts.repos.repaid) {
    parts.push(
      r.outstanding === 0n
        ? `repo #${r.id} repaid ${formatAmount(r.amount)}, in full`
        : `repo #${r.id} repaid ${formatAmount(r.amount)}, ${formatAmount(r.outstanding)} outstanding`,
    );
  }
  for (const r of facts.repos.penalised) parts.push(`repo #${r.id} penalised at ${r.rateBps} bps`);
  if (facts.revoked.length) parts.push(`revoked ${ids(facts.revoked)}`);
  for (const r of facts.reprioritised) parts.push(`#${r.id} now ${r.priority}`);
  return parts;
}

function describeChoice(choice: Choice): string {
  // A malformed params object must not take the lane down with the log line.
  try {
    return choice.action.describe(choice.params);
  } catch {
    return "";
  }
}

/** One action's result: a line in pretty mode, an object in JSON mode. */
export function formatResult(record: ResultRecord, mode: LogMode, color = false): string {
  const { choice, outcome } = record;
  const description = describeChoice(choice);
  if (mode === "json") {
    const base = {
      type: "result",
      at: record.at.toISOString(),
      lane: record.lane,
      actor: choice.actor,
      action: choice.action.name,
      group: choice.action.group,
      description,
      params: choice.params,
      outcome: outcome.kind,
      ms: record.ms,
    };
    if (outcome.kind !== "ok") {
      const { kind, code, title, detail } = outcome.error;
      return toJson({ ...base, error: { kind, ...(code !== undefined ? { code } : {}), title, detail } });
    }
    const facts = txFacts(outcome.tx.events);
    return toJson({
      ...base,
      txHash: outcome.tx.txHash,
      ledger: outcome.tx.ledger,
      ...(facts.queued.length ? { queued: facts.queued } : {}),
      settled: facts.settled,
      ...(facts.offsets.length ? { offsets: facts.offsets } : {}),
      ...(facts.repos.opened.length + facts.repos.repaid.length + facts.repos.penalised.length ? { repos: facts.repos } : {}),
      ...(facts.revoked.length ? { revoked: facts.revoked } : {}),
      ...(facts.reprioritised.length ? { reprioritised: facts.reprioritised } : {}),
    });
  }
  const paint = painter(color);
  const head = `${paint("dim", clockTime(record.at))} ${record.lane.padEnd(12)} ${choice.action.name.padEnd(13)} ${description}`;
  const took = paint("dim", `(${record.ms} ms)`);
  if (outcome.kind === "ok") {
    const what = describeFacts(txFacts(outcome.tx.events));
    const result = [paint("green", "ok"), outcome.tx.txHash.slice(0, 8), ...(what.length ? [what.join("; ")] : [])].join(" ");
    return `${head} → ${result} ${took}`;
  }
  if (outcome.kind === "refused") return `${head} → ${paint("yellow", `refused: ${outcome.error.title}`)} ${took}`;
  return `${head} → ${paint("red", `FAILED: ${outcome.error.title}`)} ${paint("dim", outcome.error.detail)} ${took}`;
}

function unavailable(info: StartInfo): Partial<Record<EntryPoint, Capability>> {
  return Object.fromEntries(Object.entries(info.capabilities).filter(([, c]) => c !== "available"));
}

/** The header `start` prints. */
export function formatStart(info: StartInfo, mode: LogMode, color = false): string {
  const missing = unavailable(info);
  if (mode === "json") {
    return toJson({
      type: "start",
      network: info.network,
      rpcUrl: info.rpcUrl,
      contractId: info.contractId,
      centralBank: info.centralBank,
      banks: info.banks,
      profile: info.profile,
      rate: info.rate,
      rngSeed: info.rngSeed,
      unavailable: missing,
    });
  }
  const paint = painter(color);
  const caps = Object.entries(missing);
  return [
    paint("bold", `RTGS simulation on ${info.network}`) + ` (${info.rpcUrl})`,
    `  contract      ${info.contractId}`,
    `  central bank  ${info.centralBank}`,
    ...info.banks.map((b, i) => `  ${i === 0 ? "banks" : ""}`.padEnd(16) + `${b.label.padEnd(8)} ${b.address}`),
    `  profile       ${info.profile} · ${info.rate} actions/s · rng seed ${info.rngSeed}`,
    caps.length
      ? `  capabilities  ${paint("yellow", `not available: ${caps.map(([e, c]) => `${e} (${c})`).join(", ")}`)}`
      : `  capabilities  all available`,
  ].join("\n");
}

// Cells are plain text: ANSI codes would count towards the column widths.
function table(rows: string[][], rightAligned: readonly number[] = []): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) =>
    r
      .map((cell, c) => (rightAligned.includes(c) ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!)))
      .join("  ")
      .trimEnd(),
  );
}

/** The conservation check, in words; the loud warning when the contract's holding isn't the sum of balances. */
export function conservationLine(conservation: SummaryBlock["conservation"], color = false): string {
  const paint = painter(color);
  if ("error" in conservation) return paint("yellow", `conservation: couldn't read the contract's holding (${conservation.error})`);
  const { held, recorded } = conservation;
  if (held === recorded) return `conservation: held ${formatAmount(held)} = recorded ${formatAmount(recorded)} ${paint("green", "✓")}`;
  const diff = held - recorded;
  return paint(
    "red",
    `!!! CONSERVATION BROKEN: the contract holds ${formatAmount(held)} but the settlement balances sum to ` +
      `${formatAmount(recorded)} (held − recorded = ${diff > 0n ? "+" : ""}${formatAmount(diff)})`,
  );
}

function feeLine(fee: SummaryBlock["fees"][number], color: boolean): string {
  const paint = painter(color);
  if (fee.xlm === undefined) return paint("yellow", `fees: couldn't read ${fee.lane}'s XLM (${fee.error ?? "unknown error"})`);
  return paint(
    "red",
    `!!! LOW XLM: ${fee.lane} has ${formatAmount(fee.xlm)} XLM, below ${formatAmount(LOW_XLM)}; friendbot won't refund it, so its fees will run out`,
  );
}

/** A periodic summary block. */
export function formatSummary(block: SummaryBlock, mode: LogMode, color = false): string {
  if (mode === "json") {
    const conservation =
      "error" in block.conservation
        ? block.conservation
        : { ...block.conservation, ok: block.conservation.held === block.conservation.recorded, difference: block.conservation.held - block.conservation.recorded };
    return toJson({ type: "summary", ...block, actionsPerMinute: round1(block.actionsPerMinute), conservation });
  }
  const paint = painter(color);
  const { totals, settlements } = block;
  const banks = table(
    [
      ["bank", "balance", "holding", "authorized", "urgent", "normal"],
      ...block.banks.map((b) => [
        b.label,
        formatAmount(b.balance),
        formatAmount(b.holding),
        b.authorized ? "yes" : "no",
        String(b.urgent),
        String(b.normal),
      ]),
    ],
    [1, 2, 4, 5],
  );
  const outstanding = block.repos.reduce((sum, r) => sum + r.outstanding, 0n);
  const repos = block.repos.length
    ? `repos: ${block.repos.length} outstanding, ${formatAmount(outstanding)} in all: ` +
      block.repos.map((r) => `#${r.id} ${r.bank} ${formatAmount(r.outstanding)} (${r.status})`).join(", ")
    : "repos: none outstanding";
  return [
    paint(
      "bold",
      `── ${formatDuration(block.elapsed)} · ${round1(block.actionsPerMinute)} actions/min · ` +
        `ok ${totals.ok} · refused ${totals.refused} · failed ${totals.failed} ──`,
    ),
    `queue: ${block.queuedCount} / ${block.queueCap}`,
    `settlements: at once ${settlements.atOnce} · eager closure ${settlements.eagerClosure} · offset ${settlements.offset}`,
    ...banks,
    repos,
    conservationLine(block.conservation, color),
    ...block.fees.map((f) => feeLine(f, color)),
  ].join("\n");
}

/** The final summary `stop` prints. */
export function formatFinal(summary: Summary, mode: LogMode, color = false): string {
  if (mode === "json") return toJson({ type: "final", ...summary });
  const paint = painter(color);
  const rows = ACTION_NAMES.filter((name) => summary.counts[name]).map((name) => {
    const c = summary.counts[name]!;
    return [name, String(c.ok), String(c.refused), String(c.failed)];
  });
  const totals = totalsOf(summary.counts);
  const { settlements } = summary;
  return [
    paint("bold", `── simulation stopped after ${formatDuration(summary.elapsed)} ──`),
    ...table([["action", "ok", "refused", "failed"], ...rows, ["total", String(totals.ok), String(totals.refused), String(totals.failed)]], [1, 2, 3]),
    `settlements: at once ${settlements.atOnce} · eager closure ${settlements.eagerClosure} · offset ${settlements.offset}`,
  ].join("\n");
}

/** The ok/refused/failed totals across every action. */
export function totalsOf(counts: Summary["counts"]): Tally {
  const totals: Tally = { ok: 0, refused: 0, failed: 0 };
  for (const c of Object.values(counts)) {
    totals.ok += c.ok;
    totals.refused += c.refused;
    totals.failed += c.failed;
  }
  return totals;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
