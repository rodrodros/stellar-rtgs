import { describe, expect, it } from "vitest";
import { Lane } from "./lane.ts";

describe("Lane", () => {
  it("runs work one at a time, in order, past failures, and knows when it is idle", async () => {
    const lane = new Lane("GBANK1");
    const log: string[] = [];
    let release!: () => void;
    const first = lane.run(
      () =>
        new Promise<void>((resolve) => {
          log.push("first start");
          release = () => {
            log.push("first end");
            resolve();
          };
        }),
    );
    const second = lane.run(async () => {
      log.push("second");
      throw new Error("boom");
    });
    const third = lane.run(async () => log.push("third"));
    expect(lane.idle).toBe(false);
    await Promise.resolve();
    expect(log).toEqual(["first start"]);
    release();
    await first;
    await expect(second).rejects.toThrow("boom");
    await third;
    expect(log).toEqual(["first start", "first end", "second", "third"]);
    expect(lane.idle).toBe(true);
  });

  it("stays usable when work throws synchronously", async () => {
    const lane = new Lane("GBANK1");
    await expect(
      lane.run(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(lane.idle).toBe(true);
  });
});
