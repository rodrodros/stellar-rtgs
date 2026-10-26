import type { SimStatus } from "@rtgs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStatusPublisher } from "./status.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(publish = vi.fn(async (_s: SimStatus) => {})) {
  let now = 1_000;
  const errors: unknown[] = [];
  const status = createStatusPublisher({ publish, now: () => now, heartbeatMs: 60_000, onError: (e) => errors.push(e) });
  return { status, publish, errors, advance: (secs: number) => (now += secs) };
}

describe("createStatusPublisher", () => {
  it("publishes running, a heartbeat each interval, then how it ended", async () => {
    const { status, publish, advance } = setup();
    await status.start();
    advance(60);
    await vi.advanceTimersByTimeAsync(60_000);
    await status.end("stopping");
    advance(5);
    await status.end("stopped");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publish.mock.calls.map(([s]) => s)).toEqual([
      { state: "running", at: 1_000 },
      { state: "running", at: 1_060 },
      { state: "stopping", at: 1_060 },
      { state: "stopped", at: 1_065 },
    ]);
  });

  it("reports a failed write and keeps beating", async () => {
    const publish = vi.fn(async (_s: SimStatus) => {}).mockRejectedValueOnce(new Error("tx_bad_seq"));
    const { status, errors } = setup(publish);
    await status.start();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(2);
    await status.end("stopped");
  });

  it("doesn't start after it has ended", async () => {
    const { status, publish } = setup();
    await status.end("stopped");
    await status.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
