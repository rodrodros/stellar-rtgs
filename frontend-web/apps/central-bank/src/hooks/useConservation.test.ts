import { describe, expect, it, vi } from "vitest";
import { conservation } from "../model/conservation.ts";
import { checkConservation } from "./useConservation.ts";

describe("checkConservation", () => {
  it("reads once when conservation holds", async () => {
    const read = vi.fn(async () => conservation(10n, [10n]));
    const wait = vi.fn(async () => {});
    expect((await checkConservation(read, wait)).holds).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("drops a mismatch that the second read doesn't see", async () => {
    const read = vi.fn().mockResolvedValueOnce(conservation(11n, [10n])).mockResolvedValueOnce(conservation(11n, [11n]));
    expect((await checkConservation(read, async () => {})).holds).toBe(true);
  });

  it("reports a mismatch both reads see", async () => {
    const read = vi.fn(async () => conservation(9n, [10n]));
    const result = await checkConservation(read, async () => {});
    expect(result.holds).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
