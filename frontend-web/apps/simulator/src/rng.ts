// Seeded randomness (mulberry32): the same seed gives the same run of choices.
import type { Rng } from "./types.ts";

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bigint: (min, max) => {
      if (max <= min) return min;
      // 53 random bits are plenty for stroop amounts; the modulo bias is negligible.
      const r = BigInt(Math.floor(next() * 2 ** 53));
      return min + (r % (max - min + 1n));
    },
    pick: (xs) => {
      if (xs.length === 0) throw new Error("pick from an empty list");
      return xs[Math.floor(next() * xs.length)]!;
    },
    chance: (p) => next() < p,
  };
  return rng;
}
