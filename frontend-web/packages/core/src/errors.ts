// The one mapping from failures (the settlement contract's `Error` codes, the cash token's SAC,
// classic transaction results, RPC and wallets) to messages in the glossary's terms.

export type RtgsErrorKind =
  | "contract" // the settlement contract refused (code 1-16)
  | "token" // the cash token's SAC or a classic operation on it refused
  | "not-implemented" // the entry point is still a stub in the deployed contract
  | "rpc" // the network's RPC failed or is unreachable
  | "transaction" // the network refused the transaction (fee, sequence, reserve)
  | "wallet" // the wallet refused or failed to sign
  | "network-mismatch" // a signer or RPC belongs to another network
  | "mainnet-not-acknowledged"
  | "unauthorized-signer" // e.g. a non-admin signer for a token admin action
  | "archived" // the entry's time to live ran out
  | "config"; // missing or invalid configuration

export class RtgsError extends Error {
  readonly kind: RtgsErrorKind;
  readonly code?: number;
  readonly title: string;
  readonly detail: string;

  constructor(kind: RtgsErrorKind, title: string, detail: string, opts: { code?: number; cause?: unknown } = {}) {
    super(`${title}: ${detail}`, { cause: opts.cause });
    this.name = "RtgsError";
    this.kind = kind;
    this.title = title;
    this.detail = detail;
    if (opts.code !== undefined) this.code = opts.code;
  }
}

export interface ErrorText {
  name: string;
  title: string;
  detail: string;
}

/** The settlement contract's `Error` enum (contracts/settlement/src/lib.rs). */
export const CONTRACT_ERRORS: Readonly<Record<number, ErrorText>> = {
  1: {
    name: "InvalidAmount",
    title: "Invalid amount",
    detail: "The amount must be greater than zero (a collateral value may be zero).",
  },
  2: {
    name: "TokenTransferFailed",
    title: "Cash token transfer refused",
    detail:
      "The cash token refused to move the funds into or out of the settlement contract. Check the bank's cash token holding and that the cash token's issuer has authorized its trustline.",
  },
  3: {
    name: "InsufficientFunds",
    title: "Settlement balance too low",
    detail: "The bank's settlement balance is below the amount.",
  },
  4: {
    name: "SameAccount",
    title: "Same sender and receiver",
    detail: "A payment order must go to another participant.",
  },
  5: {
    name: "QueueFull",
    title: "Central queue full",
    detail:
      "The central queue already holds as many payment orders as the queue cap allows, and this one is not covered, so it would have to queue.",
  },
  6: { name: "UnknownPayment", title: "Unknown payment order", detail: "No payment order has this id." },
  7: {
    name: "NotQueued",
    title: "Payment order is final",
    detail: "The payment order is no longer queued: it has settled, been revoked or expired.",
  },
  8: {
    name: "SamePriority",
    title: "Same priority class",
    detail: "The payment order already has this priority class.",
  },
  9: {
    name: "NotExpired",
    title: "Not expired yet",
    detail: "The payment order's expiry hasn't passed, so it can't be rejected yet.",
  },
  10: { name: "NotAuthorized", title: "Not authorized", detail: "This account may not take this action." },
  11: {
    name: "CollateralBelowCredit",
    title: "Collateral below credit",
    detail: "The collateral would fall below the intraday credit it backs.",
  },
  12: {
    name: "CreditExceedsCollateral",
    title: "Credit exceeds collateral",
    detail: "The repo would take the bank's intraday credit above its collateral.",
  },
  13: { name: "UnknownRepo", title: "Unknown repo", detail: "No repo has this id." },
  14: {
    name: "RepayExceedsRepo",
    title: "Repayment exceeds the repo",
    detail: "The repayment is more than the repo's outstanding amount.",
  },
  15: {
    name: "NotOverdue",
    title: "Repo not overdue",
    detail: "The repo's term hasn't passed, or it is already repaid.",
  },
  16: { name: "AlreadyPenalty", title: "Already a penalty repo", detail: "The repo is already a penalty repo." },
};

/** The Stellar Asset Contract's errors (soroban-env-host `ContractError`). */
export const SAC_ERRORS: Readonly<Record<number, ErrorText>> = {
  4: { name: "UnauthorizedError", title: "Not the SAC admin", detail: "Only the cash token's SAC admin may do this." },
  5: { name: "AuthenticationError", title: "Not authorized", detail: "The holder did not authorize the transfer." },
  6: { name: "AccountMissingError", title: "No such account", detail: "The account does not exist on this network." },
  8: { name: "NegativeAmountError", title: "Invalid amount", detail: "The amount must not be negative." },
  10: {
    name: "BalanceError",
    title: "Cash token holding too low",
    detail: "The holder doesn't hold enough of the cash token.",
  },
  11: {
    name: "BalanceDeauthorizedError",
    title: "Holder not authorized",
    detail: "The cash token's issuer has not authorized this holder.",
  },
  12: { name: "OverflowError", title: "Holding limit exceeded", detail: "The holder's balance would overflow its limit." },
  13: {
    name: "TrustlineMissingError",
    title: "No trustline",
    detail: "The account has no trustline for the cash token.",
  },
};

/** Classic transaction and operation result codes. */
const RESULT_CODES: Readonly<Record<string, [RtgsErrorKind, string, string]>> = {
  tx_bad_seq: ["transaction", "Sequence number out of date", "Another transaction from this account got in first; try again."],
  tx_insufficient_fee: ["transaction", "Fee too low", "The network asked for a higher fee; try again."],
  tx_insufficient_balance: ["transaction", "Not enough XLM", "The account can't pay the transaction fee."],
  tx_no_account: ["transaction", "No such account", "The source account does not exist on this network; fund it first."],
  tx_bad_auth: ["transaction", "Bad signature", "The transaction was not signed by the right key for this network."],
  op_no_trust: ["token", "No trustline", "The account has no trustline for the cash token."],
  op_not_authorized: ["token", "Trustline not authorized", "The cash token's issuer has not authorized this trustline."],
  op_underfunded: ["token", "Cash token holding too low", "The account doesn't hold enough of the cash token."],
  op_line_full: ["token", "Holding limit exceeded", "The receiver's trustline limit is too low."],
  op_low_reserve: ["transaction", "Not enough XLM for the reserve", "The account needs more XLM to add this entry."],
  op_no_issuer: ["token", "No issuer", "The cash token's issuing account doesn't exist."],
  op_cant_clawback: ["token", "Clawback not possible", "This trustline was not created with clawback enabled."],
  op_name_not_found: ["transaction", "No such data entry", "The account has no data entry with that name."],
};

export function contractError(code: number, cause?: unknown): RtgsError {
  const text = CONTRACT_ERRORS[code];
  if (!text) return new RtgsError("contract", `Contract error #${code}`, "The settlement contract refused the call.", { code, cause });
  return new RtgsError("contract", text.title, text.detail, { code, cause });
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(e);
  }
}

/** Whether a host error text is a Wasm trap, which a `todo!()` stub raises. */
export function isWasmTrap(text: string): boolean {
  return /Error\(WasmVm,/.test(text) || /UnreachableCodeReached/.test(text);
}

/**
 * Maps anything thrown by core, the SDK, RPC or a wallet to an `RtgsError`. `source` says
 * whose contract errors an `Error(Contract, #n)` refers to.
 */
export function toRtgsError(e: unknown, source: "settlement" | "sac" = "settlement"): RtgsError {
  if (e instanceof RtgsError) return e;
  const text = messageOf(e);

  // The SDK's Err({ message }) for a Result-typed contract function.
  if (e && typeof e === "object" && "error" in e) {
    const inner = (e as { error?: { message?: string } }).error;
    const entry = Object.entries(CONTRACT_ERRORS).find(([, t]) => t.name === inner?.message);
    if (entry) return contractError(Number(entry[0]), e);
  }

  const contract = /Error\(Contract, #(\d+)\)/.exec(text);
  if (contract) {
    const code = Number(contract[1]);
    if (source === "sac") {
      const t = SAC_ERRORS[code];
      return new RtgsError("token", t?.title ?? `Cash token error #${code}`, t?.detail ?? "The cash token refused the call.", {
        code,
        cause: e,
      });
    }
    return contractError(code, e);
  }
  if (isWasmTrap(text)) {
    return new RtgsError("not-implemented", "Not implemented yet", "The deployed settlement contract doesn't implement this entry point yet.", {
      cause: e,
    });
  }
  if (/Error\(Storage, MissingValue\)/.test(text)) {
    return new RtgsError("config", "Nothing deployed there", "No contract (or no entry it needs) exists at that address on this network; it may have been reset.", {
      cause: e,
    });
  }
  if (/archived|EntryArchived|restore some contract state/i.test(text)) {
    return new RtgsError("archived", "Archived entry", "A ledger entry this call needs is archived and must be restored first.", {
      cause: e,
    });
  }
  for (const [code, [kind, title, detail]] of Object.entries(RESULT_CODES)) {
    if (text.includes(code)) return new RtgsError(kind, title, detail, { cause: e });
  }
  if (/reject|declin|denied|cancel/i.test(text) && /user|wallet/i.test(text)) {
    return new RtgsError("wallet", "Signature refused", "The wallet did not sign the transaction.", { cause: e });
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|NetworkError|Failed to fetch|timeout|ETIMEDOUT|socket hang up/i.test(text)) {
    return new RtgsError("rpc", "Network unreachable", "The network's RPC did not answer. Check the RPC URL and that the network is up.", {
      cause: e,
    });
  }
  return new RtgsError("rpc", "Unexpected failure", text.slice(0, 500), { cause: e });
}

/**
 * Reports an exception from an app's listener without letting it break core's own loop: the
 * host's `reportError` (browsers, Node 22+), else the console.
 */
export function reportListenerError(e: unknown): void {
  const report = (globalThis as { reportError?: (e: unknown) => void }).reportError;
  if (report) report(e);
  else console.error("@rtgs/core: a listener threw", e);
}

/** Calls each listener, reporting rather than propagating what it throws. */
export function notifyAll<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch (e) {
      reportListenerError(e);
    }
  }
}
