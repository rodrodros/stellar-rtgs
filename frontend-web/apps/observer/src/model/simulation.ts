// What the headless simulator is doing, for viewers of a hosted devnet. The simulator publishes
// its status on the central bank's account (`rtgs.sim`) and rewrites `running` every minute;
// this decides what to tell the viewer from that status, the ledger clock and the latest event.
// Every time is ledger close time, the RTGS's clock, so a viewer's own clock never matters.
import type { SimStatus } from "../core.ts";

/** A `running` status older than this means the simulator died without saying so. */
export const HEARTBEAT_STALE_SECS = 180;
/** A running simulation with no contract events for this long is worth pointing out. */
export const QUIET_SECS = 90;

export type SimView =
  /** No simulator has ever published here, or the clock isn't known yet. */
  | { kind: "none" }
  | { kind: "live" }
  /** Running, but nothing has reached the contract for `quietSecs`. */
  | { kind: "quiet"; quietSecs: number }
  /** Paused on purpose: stopping, or stopped, since `at`. */
  | { kind: "paused"; state: "stopping" | "stopped"; at: number; secs: number }
  /** Last heard from at `at`, and silent since. */
  | { kind: "lost"; at: number; secs: number };

export function simView(status: SimStatus | undefined, now: number | undefined, lastEventAt: number | undefined): SimView {
  if (!status || now === undefined) return { kind: "none" };
  const secs = Math.max(0, now - status.at);
  if (status.state !== "running") return { kind: "paused", state: status.state, at: status.at, secs };
  if (secs > HEARTBEAT_STALE_SECS) return { kind: "lost", at: status.at, secs };
  // The status time is when this run last beat; before its first event, it is that time.
  const since = Math.max(lastEventAt ?? 0, status.at);
  const quietSecs = now - since;
  return quietSecs > QUIET_SECS ? { kind: "quiet", quietSecs } : { kind: "live" };
}
