import { describe, expect, it } from "vitest";
import { HEARTBEAT_STALE_SECS, QUIET_SECS, simView } from "./simulation.ts";

const NOW = 1_800_000_000;

describe("simView", () => {
  it("says nothing without a status or a clock", () => {
    expect(simView(undefined, NOW, NOW)).toEqual({ kind: "none" });
    expect(simView({ state: "running", at: NOW }, undefined, NOW)).toEqual({ kind: "none" });
  });

  it("is live while the heartbeat is fresh and transactions arrive", () => {
    expect(simView({ state: "running", at: NOW - 30 }, NOW, NOW - 2)).toEqual({ kind: "live" });
    // A fresh run with no events yet counts from its own status.
    expect(simView({ state: "running", at: NOW - 10 }, NOW, undefined)).toEqual({ kind: "live" });
    expect(simView({ state: "running", at: NOW - 10 }, NOW, NOW - 3_600)).toEqual({ kind: "live" });
  });

  it("is quiet when running but no event has arrived for a while", () => {
    expect(simView({ state: "running", at: NOW - QUIET_SECS - 1 }, NOW, NOW - 500)).toEqual({ kind: "quiet", quietSecs: QUIET_SECS + 1 });
  });

  it("is lost once the heartbeat is stale", () => {
    expect(simView({ state: "running", at: NOW - HEARTBEAT_STALE_SECS }, NOW, NOW)).not.toMatchObject({ kind: "lost" });
    expect(simView({ state: "running", at: NOW - HEARTBEAT_STALE_SECS - 1 }, NOW, NOW)).toEqual({
      kind: "lost",
      at: NOW - HEARTBEAT_STALE_SECS - 1,
      secs: HEARTBEAT_STALE_SECS + 1,
    });
  });

  it("is paused while stopping or stopped, however old", () => {
    expect(simView({ state: "stopping", at: NOW - 5 }, NOW, NOW)).toEqual({ kind: "paused", state: "stopping", at: NOW - 5, secs: 5 });
    expect(simView({ state: "stopped", at: NOW - 10_000 }, NOW, NOW)).toEqual({ kind: "paused", state: "stopped", at: NOW - 10_000, secs: 10_000 });
  });
});
