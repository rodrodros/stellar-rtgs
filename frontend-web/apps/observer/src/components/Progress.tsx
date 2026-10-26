// The loading bar: how far connecting, the first read of the views, and then the replay of the
// retention window's events have got. Over a public RPC each takes a while.
import { useId } from "react";
import { useSnapshot, type FeedStatus, type LoadProgress, type LoadStep } from "../core.ts";

/** A bar with its caption; without `fraction` it is indeterminate. */
export function ProgressBar(props: { fraction?: number; label: string }) {
  const id = useId();
  const percent = props.fraction === undefined ? undefined : Math.round(Math.min(1, Math.max(0, props.fraction)) * 100);
  return (
    <div className="load">
      <div
        className={`load-bar${percent === undefined ? " indeterminate" : ""}`}
        role="progressbar"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === undefined ? {} : { "aria-valuenow": percent })}
      >
        <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
      <p id={id}>{props.label}</p>
    </div>
  );
}

const counted = (p: LoadProgress) => (p.total !== undefined ? ` (${(p.done ?? 0).toLocaleString()} of ${p.total.toLocaleString()})` : "");

const STEP_LABELS: Record<LoadStep, (p: LoadProgress) => string> = {
  config: () => "reading the contract's configuration",
  registry: () => "reading the bank registry",
  banks: (p) => `reading the banks' balances and queues${counted(p)}`,
  payments: (p) => (p.total === undefined ? "finding the newest payment order" : `reading recent payment orders${counted(p)}`),
  repos: (p) => (p.total === undefined ? "finding the newest repo" : `reading recent repos${counted(p)}`),
};

/** The first read of the views, step by step: each step an equal share of the bar. */
export function loadFraction(p: LoadProgress): number {
  const within = p.total ? (p.done ?? 0) / p.total : 0;
  return (p.index + within) / p.count;
}

/** The replay of past events, by ledger; undefined until the feed knows where it is. */
export function backfillFraction(feed: FeedStatus): number | undefined {
  const { startLedger: start, cursorLedger: cursor, latestLedger: latest } = feed;
  if (start === undefined || cursor === undefined || latest === undefined) return undefined;
  return latest > start ? (cursor - start) / (latest - start) : 1;
}

/** The store's loading, then the event history's; nothing once live, or on an error (its banner says). */
export function LoadBar() {
  const status = useSnapshot((s) => s.status);
  const loading = useSnapshot((s) => s.loading);
  const feed = useSnapshot((s) => s.feed);
  if (status === "loading") {
    if (!loading) return <ProgressBar label="Reading balances, queues and recent payment orders…" />;
    return <ProgressBar fraction={loadFraction(loading)} label={`Step ${loading.index + 1} of ${loading.count}: ${STEP_LABELS[loading.step](loading)}…`} />;
  }
  if (status === "ready" && feed.state === "backfilling") {
    const label =
      feed.cursorLedger !== undefined && feed.latestLedger !== undefined
        ? `Loading the event history: ledger ${feed.cursorLedger.toLocaleString()} of ${feed.latestLedger.toLocaleString()}…`
        : "Loading the event history…";
    return <ProgressBar fraction={backfillFraction(feed)} label={label} />;
  }
  return null;
}
