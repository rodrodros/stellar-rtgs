// The contracts every part of the simulator meets at. The lead owns this file: the engine,
// world, action modules, policy and reporter are built in parallel against it, so a change
// here is asked for, not made in a branch.
import type {
  Capabilities,
  Config,
  Credit,
  EntryPoint,
  Payment,
  Repo,
  RtgsActor,
  RtgsError,
  TokenAdmin,
  TxOutcome,
} from "@rtgs/core";

/** Who signs an action: a bank, or the central bank (operator, settlement agent, token admin). */
export type Role = "bank" | "central-bank";
export type ActionGroup = "payments" | "credit" | "token";
export type ActionName =
  | "deposit"
  | "withdraw"
  | "submit"
  | "revoke"
  | "reprioritise"
  | "setCollateral"
  | "openRepo"
  | "repay"
  | "issue"
  | "clawback"
  | "deauthorize"
  | "reauthorize";

/** Seeded randomness (`createRng` in rng.ts), so a run can be repeated. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** Uniform bigint in [min, max], both inclusive. */
  bigint(min: bigint, max: bigint): bigint;
  pick<T>(xs: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
}

/** A bank as the simulation sees it: the contract's view plus its cash token trustline. */
export interface BankState {
  address: string;
  /** The devnet label, e.g. "Bank 1". */
  label: string;
  /** Settlement balance, in the contract. */
  balance: bigint;
  /** Cash tokens in the bank's trustline, outside the contract. */
  holding: bigint;
  /** Whether the central bank has authorized the trustline (deposit and withdraw need it). */
  authorized: boolean;
  /** Queued payment orders it sent, head first, per priority class. */
  queues: { urgent: Payment[]; normal: Payment[] };
  /** Undefined while `credit` is a stub. */
  credit?: Credit;
  /** From `CollateralSet` events; undefined if none was seen. */
  collateral?: bigint;
}

/** What actions and the policy read. Synchronous: it answers from the latest snapshot. */
export interface WorldView {
  readonly centralBank: string;
  readonly contractId: string;
  /** Ledger close time, Unix seconds: the RTGS's clock. */
  now(): number;
  config(): Config;
  capabilities(): Capabilities;
  /** Payment orders queued across all banks, against `config().queueCap`. */
  queuedCount(): number;
  banks(): readonly BankState[];
  bank(address: string): BankState | undefined;
  /** Queued payment orders, all or those sent by `from`, oldest first. */
  queuedPayments(from?: string): Payment[];
  /** Repos not yet repaid, all or one bank's. */
  repos(bank?: string): Repo[];
}

export interface World extends WorldView {
  /** Resolves once the store is ready and every bank's trustline has been read. */
  start(): Promise<void>;
  /** Re-reads what the snapshot doesn't carry (trustlines) for these addresses. */
  refresh(addresses: readonly string[]): Promise<void>;
  stop(): void;
}

/** Signed entry points for every lane. */
export interface Actors {
  bank(address: string): RtgsActor;
  centralBank: RtgsActor;
  tokenAdmin: TokenAdmin;
}

/** Knobs the policy sets and actions read. Amounts in stroops. */
export interface Tuning {
  paymentSize: { min: bigint; max: bigint };
  /** Uncovered submissions stop while fewer than this many central queue slots are free. */
  queueHeadroom: number;
  /** The central bank tops a bank's holding up when it falls below this. */
  holdingFloor: bigint;
  /** The central bank claws back from a holding above this. */
  holdingCeiling: bigint;
  /** How long a trustline stays deauthorized before it is reauthorized. */
  deauthorizeSecs: number;
  collateral: { min: bigint; max: bigint };
}

export interface PlanContext {
  world: WorldView;
  rng: Rng;
  /** The lane's address: a bank, or the central bank. */
  actor: string;
  tuning: Tuning;
}

/** One operation the simulation can perform. */
export interface ActionDef<P = unknown> {
  name: ActionName;
  group: ActionGroup;
  role: Role;
  /** Skipped unless `capabilities[capability] === "available"`. */
  capability?: EntryPoint;
  /** Parameters for this actor now, or undefined when the action doesn't apply. */
  plan(ctx: PlanContext): P | undefined;
  run(actors: Actors, actor: string, params: P): Promise<TxOutcome<unknown>>;
  /** One line for the log, e.g. "100.00 USD to Bank 2 (urgent)". */
  describe(params: P): string;
  /** Addresses whose trustlines the world should re-read after the action. */
  touches(actor: string, params: P): string[];
}

export interface ActionModule {
  group: ActionGroup;
  /** Each action has its own params type. */
  actions: readonly ActionDef<any>[];
  /** Runs at start and at stop: undoes what a stopped or crashed run left half done. */
  recover?(actors: Actors, world: World): Promise<void>;
}

/**
 * `refused`: an expected refusal, e.g. a race with the eager closure (`NotQueued`).
 * `failed`: anything else; a healthy run has none.
 */
export type Outcome = { kind: "ok"; tx: TxOutcome<unknown> } | { kind: "refused" | "failed"; error: RtgsError };

export interface Choice {
  /** Typed by `action`, whose `plan` returned them. */
  action: ActionDef<any>;
  actor: string;
  params: unknown;
}

export interface Policy {
  /** At most one choice per idle actor; an actor with nothing to do is left out. */
  choose(world: WorldView, idleActors: readonly string[]): Choice[];
}

export interface StartInfo {
  network: string;
  rpcUrl: string;
  contractId: string;
  centralBank: string;
  banks: readonly { address: string; label: string }[];
  profile: string;
  /** Actions per second, across all lanes. */
  rate: number;
  capabilities: Capabilities;
}

export interface Summary {
  /** Seconds since `start`. */
  elapsed: number;
  counts: Partial<Record<ActionName, { ok: number; refused: number; failed: number }>>;
  /** Settlements seen in the simulation's own transactions, by how they settled. */
  settlements: { atOnce: number; eagerClosure: number; offset: number };
}

export interface Reporter {
  start(info: StartInfo): void;
  result(choice: Choice, outcome: Outcome, ms: number): void;
  /** Called every engine tick; the reporter decides when to print a periodic summary. */
  tick(world: WorldView): void;
  stop(): Summary;
}
