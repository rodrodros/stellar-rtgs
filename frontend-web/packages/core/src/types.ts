// The domain types the apps see: amounts are bigint stroops, addresses strkeys, times Unix
// seconds of ledger close time. No XDR crosses this boundary.

/** Two priority classes, each queued strictly first in, first out (ADR-0008, ADR-0009). */
export type Priority = "urgent" | "normal";

/** `expired` is the model's `rejected` (A5, ADR-0015). */
export type PaymentStatus = "queued" | "settled" | "revoked" | "expired";

export interface Config {
  /** The most payment orders queued at once across all banks (ADR-0010). */
  queueCap: number;
  /** Seconds after submission after which a queued payment order may be rejected (ADR-0015). */
  expirySecs: number;
  /** Seconds after it opens after which an unpaid repo becomes a penalty repo (ADR-0014). */
  repoTermSecs: number;
  /** The rate recorded on a penalty repo, in basis points (ADR-0014). */
  penaltyRateBps: number;
}

/** A payment order. Its id is its sequence number; ids are issued 0, 1, 2, ... */
export interface Payment {
  id: bigint;
  from: string;
  to: string;
  amount: bigint;
  priority: Priority;
  submittedAt: number;
  status: PaymentStatus;
  settledAt?: number;
}

/** A bank's credit position (the contract's `cr`, `ovn`, `coll`). */
export interface Credit {
  /** Intraday credit outstanding. */
  intraday: bigint;
  /** Penalty repos outstanding (they replace overnight credit, ADR-0014). */
  penalty: bigint;
  /** Collateral value, after haircuts. */
  collateral: bigint;
}

export type RepoStatus = "intraday" | "penalty" | "repaid";

/** One intraday repo (ADR-0011, ADR-0014). */
export interface Repo {
  id: bigint;
  bank: string;
  amount: bigint;
  outstanding: bigint;
  openedAt: number;
  status: RepoStatus;
  /** The penalty rate, recorded when the repo becomes a penalty repo; 0 before. */
  rateBps: number;
}

/** Where an event was emitted. `eventId` is RPC's id, which orders events. */
export interface EventMeta {
  eventId: string;
  ledger: number;
  /** Ledger close time, Unix seconds. */
  closedAt: number;
  txHash: string;
  contractId: string;
}

/** The settlement contract's 12 events, plus `Unknown` for any it adds later. */
export type RtgsEventBody =
  | { type: "Deposited"; bank: string; amount: bigint }
  | { type: "Withdrawn"; bank: string; amount: bigint }
  | { type: "Submitted"; id: bigint; from: string; to: string; amount: bigint; priority: Priority }
  | { type: "Settled"; id: bigint; from: string; to: string; amount: bigint }
  | { type: "Offset"; ids: bigint[] }
  | { type: "Revoked"; id: bigint }
  | { type: "Reprioritised"; id: bigint; priority: Priority }
  | { type: "Expired"; id: bigint }
  | { type: "CollateralSet"; bank: string; value: bigint }
  | { type: "RepoOpened"; id: bigint; bank: string; amount: bigint }
  | { type: "RepoRepaid"; id: bigint; amount: bigint; outstanding: bigint }
  | { type: "RepoPenalised"; id: bigint; rateBps: number }
  | { type: "Unknown"; name?: string; topics: unknown[]; value: unknown };

export type RtgsEvent = EventMeta & RtgsEventBody;
export type RtgsEventType = RtgsEventBody["type"];

/** A cash token (SAC) event: CAP-67 `transfer`, `mint`, `burn`, `clawback`, `set_authorized`, ... */
export type TokenEvent = EventMeta & {
  type: "Token";
  action: string;
  from?: string;
  to?: string;
  amount?: bigint;
  authorized?: boolean;
  asset?: string;
};

export type FeedEvent = RtgsEvent | TokenEvent;

export interface TxOutcome<T = void> {
  txHash: string;
  ledger: number;
  closedAt: number;
  value: T;
  /** The settlement contract's events from this transaction, in order. */
  events: RtgsEvent[];
}
