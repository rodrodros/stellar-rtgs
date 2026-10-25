import { describe, expect, it } from "vitest";
import { WriteQueue } from "./writeQueue.ts";

describe("WriteQueue", () => {
  it("sends one write at a time, in order, even after a failure", async () => {
    const queue = new WriteQueue();
    const log: string[] = [];
    let releaseFirst!: () => void;
    const first = queue.run(async () => {
      log.push("first start");
      await new Promise<void>((r) => (releaseFirst = r));
      log.push("first end");
      throw new Error("refused");
    });
    const second = queue.run(async () => {
      log.push("second");
      return 2;
    });
    await Promise.resolve();
    expect(log).toEqual(["first start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("refused");
    expect(await second).toBe(2);
    expect(log).toEqual(["first start", "first end", "second"]);
  });
});
