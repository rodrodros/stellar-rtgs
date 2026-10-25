// What an action's failure means for the run. Between `plan` and the transaction's inclusion the
// world moves on (the eager closure settles a payment, another lane spends a balance), so some
// refusals are expected races; others are a busy network worth retrying; the rest are bugs.
import { toRtgsError } from "@rtgs/core";
import type { RtgsError } from "@rtgs/core";

/**
 * `transient`: try again (a stale sequence number, RPC trouble, a send that wasn't confirmed).
 * `refused`: an expected race with the world. `failed`: anything else.
 */
export type Classification = "refused" | "failed" | "transient";

/** The cash token's SAC errors that a holding or trustline changing underneath an action raises. */
const SAC_RACES = new Set([10, 11]); // BalanceError, BalanceDeauthorizedError

/** Classic operation results with the same meaning (`op_underfunded`, `op_not_authorized`), by title. */
const CLASSIC_RACES = new Set(["Cash token holding too low", "Trustline not authorized"]);

/** Transaction results that a retry fixes (`tx_bad_seq`, `tx_insufficient_fee`, `TRY_AGAIN_LATER`, a poll that ran out). */
const TRANSIENT_TRANSACTIONS = new Set(["Sequence number out of date", "Fee too low", "Network busy", "Not confirmed"]);

export function classify(e: unknown): Classification {
  const error: RtgsError = toRtgsError(e);
  switch (error.kind) {
    case "rpc":
      // "Unexpected failure" is toRtgsError's catch-all, a thrown TypeError included: not RPC's.
      return error.title === "Unexpected failure" ? "failed" : "transient";
    case "transaction":
      return TRANSIENT_TRANSACTIONS.has(error.title) ? "transient" : "failed";
    case "contract":
      // 2 TokenTransferFailed and 3-16: balances, queue state, credit and repos that moved.
      // 1 InvalidAmount is a planning bug.
      return error.code !== undefined && error.code >= 2 && error.code <= 16 ? "refused" : "failed";
    case "token":
      if (error.code !== undefined) return SAC_RACES.has(error.code) ? "refused" : "failed";
      return CLASSIC_RACES.has(error.title) ? "refused" : "failed";
    default:
      return "failed";
  }
}
