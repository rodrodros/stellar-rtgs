// The devnet bootstrap form: text fields parsed into a Config, refusing what the contract
// would misread (an empty field is not 0) or reject.
import type { Config } from "@rtgs/core";

export type ConfigForm = Record<keyof Config, string>;

/** The smallest value each Config field accepts: a queue cap of 0 would refuse every queued payment. */
const CONFIG_MIN: Record<keyof Config, number> = { queueCap: 1, expirySecs: 1, repoTermSecs: 1, penaltyRateBps: 0 };
const U32_MAX = 4_294_967_295;

/**
 * The largest queue cap the implementation has priced: above it, the eager closure over a full
 * queue can exceed Mainnet's per-transaction limits, and the deposit or submission that
 * triggers it always fails (stellar-implementation's README, Flows 14 and 22).
 */
export const MAX_QUEUE_CAP = 62;

/** A whole number within [min, max], or undefined. */
export function parseWhole(text: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : undefined;
}

/** The Config the form describes, or the fields that are invalid. */
export function parseConfig(form: ConfigForm): { config: Config } | { invalid: (keyof Config)[] } {
  const keys = Object.keys(CONFIG_MIN) as (keyof Config)[];
  const values = keys.map((k) => parseWhole(form[k], CONFIG_MIN[k], k === "queueCap" ? MAX_QUEUE_CAP : k === "penaltyRateBps" ? U32_MAX : undefined));
  const invalid = keys.filter((_, i) => values[i] === undefined);
  if (invalid.length) return { invalid };
  return { config: Object.fromEntries(keys.map((k, i) => [k, values[i]!])) as unknown as Config };
}
