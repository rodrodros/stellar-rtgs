import { describe, expect, it } from "vitest";
import { createRng } from "./rng.ts";

describe("createRng", () => {
  it("repeats a run for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
  });

  it("keeps int and bigint within their bounds", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const n = rng.int(3, 5);
      expect(n >= 3 && n <= 5).toBe(true);
      const b = rng.bigint(10n, 12n);
      expect(b >= 10n && b <= 12n).toBe(true);
    }
    expect(rng.bigint(9n, 9n)).toBe(9n);
  });
});
