// Keeps every lane's account in XLM for fees. Friendbot funds an account once and won't refund
// it, so a run of days would otherwise drain its lanes (each pays its own fees). Below the
// threshold a lane is refuelled with a fresh friendbot grant merged into it (`session.refuel`),
// which never uses the lane's own sequence number, so it runs beside the engine.
import { toRtgsError, type RtgsError } from "@rtgs/core";

export type RefuelResult = { amount: bigint } | { error: RtgsError };

export interface RefuelerOptions {
  lanes: readonly string[];
  /** Refuel a lane whose XLM, in stroops, is below this. */
  belowStroops: bigint;
  xlmBalance(address: string): Promise<bigint>;
  /** Resolves with the stroops added. */
  refuel(address: string): Promise<bigint>;
  onRefuel(address: string, result: RefuelResult): void;
}

export interface Refueler {
  /** Reads every lane and refuels those below the threshold, one at a time. Never rejects. */
  check(): Promise<void>;
}

export function createRefueler(options: RefuelerOptions): Refueler {
  let checking: Promise<void> | undefined;

  async function run(): Promise<void> {
    for (const lane of options.lanes) {
      let xlm: bigint;
      try {
        xlm = await options.xlmBalance(lane);
      } catch {
        // The summary reports unreadable balances; the next check tries again.
        continue;
      }
      if (xlm >= options.belowStroops) continue;
      let result: RefuelResult;
      try {
        result = { amount: await options.refuel(lane) };
      } catch (e) {
        result = { error: toRtgsError(e) };
      }
      try {
        options.onRefuel(lane, result);
      } catch {
        // A reporter that throws must not stop the other lanes' refuels.
      }
    }
  }

  return {
    check() {
      // A check still running (friendbot is slow) is the one the caller waits for.
      checking ??= run().finally(() => (checking = undefined));
      return checking;
    },
  };
}
