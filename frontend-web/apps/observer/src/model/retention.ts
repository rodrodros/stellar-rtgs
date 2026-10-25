// Where the observer's history starts, and the RPC retention window that bounds it: RPC keeps
// events for its window only (about 7 days by default), so nothing older can be loaded.
import type { FeedStart, FeedStatus } from "../core.ts";

/** The whole retention window, live ledgers only, or from a ledger number. */
export type StartChoice = "retention" | "now" | number;

export function toFeedStart(choice: StartChoice): FeedStart {
  if (choice === "retention") return "retention-start";
  if (choice === "now") return "now";
  return { ledger: choice };
}

export function parseStart(text: string | null | undefined): StartChoice {
  if (text === "now") return "now";
  if (text && /^\d+$/.test(text)) return Number(text);
  return "retention";
}

export interface RetentionWindow {
  oldestLedger: number;
  latestLedger: number;
  oldestCloseTime: number;
  latestCloseTime: number;
  ledgers: number;
  spanSecs: number;
}

/** The window as the feed last saw it; undefined until the feed's first response. */
export function retentionWindow(status: FeedStatus): RetentionWindow | undefined {
  const { oldestLedger, latestLedger, oldestLedgerCloseTime, latestLedgerCloseTime } = status;
  if (oldestLedger === undefined || latestLedger === undefined || oldestLedgerCloseTime === undefined || latestLedgerCloseTime === undefined) {
    return undefined;
  }
  return {
    oldestLedger,
    latestLedger,
    oldestCloseTime: oldestLedgerCloseTime,
    latestCloseTime: latestLedgerCloseTime,
    ledgers: latestLedger - oldestLedger + 1,
    spanSecs: Math.max(0, latestLedgerCloseTime - oldestLedgerCloseTime),
  };
}

/** The ledger about `secs` before the latest, from the window's average close interval, clamped to the window. */
export function ledgerSecondsAgo(window: RetentionWindow, secs: number): number {
  const ledgers = window.latestLedger - window.oldestLedger;
  if (ledgers <= 0 || window.spanSecs <= 0) return window.oldestLedger;
  const perLedger = window.spanSecs / ledgers;
  const back = Math.ceil(secs / perLedger);
  return Math.max(window.oldestLedger, window.latestLedger - back);
}

/** Why a start ledger can't be used, or undefined if it can. */
export function checkStartLedger(ledger: number, window: RetentionWindow | undefined): string | undefined {
  if (!Number.isInteger(ledger) || ledger < 1) return "Enter a ledger number.";
  if (!window) return undefined;
  if (ledger < window.oldestLedger) return `RPC no longer keeps ledger ${ledger}: the oldest it keeps is ${window.oldestLedger}.`;
  if (ledger > window.latestLedger) return `Ledger ${ledger} hasn't closed yet: the latest is ${window.latestLedger}.`;
  return undefined;
}
