// The loop: one serial lane per signer, a rate budget, retries, outcome classification and a
// graceful stop. Ticket 01.
//
// Every tick the engine asks the policy what each idle lane should do, against the latest
// snapshot. A choice over the rate budget is dropped, not queued: next tick the policy chooses
// again against a fresher world. Lanes never reject: whatever an action, the reporter or the
// world throws ends up as an outcome or in `onError`.
import { RtgsError, toRtgsError } from "@rtgs/core";
import type { TxOutcome } from "@rtgs/core";
import type { ActionModule, Actors, Choice, ExclusionKey, Outcome, Policy, Reporter, World } from "../types.ts";
import { classify } from "./classify.ts";
import { Lane } from "./lane.ts";

export { classify } from "./classify.ts";
export type { Classification } from "./classify.ts";
export { Lane } from "./lane.ts";

export interface EngineOptions {
  world: World;
  policy: Policy;
  reporter: Reporter;
  actors: Actors;
  modules: readonly ActionModule[];
  /** One lane per signer: every bank's address and the central bank's. */
  lanes: readonly string[];
  /** Actions started per second, across all lanes. */
  rate: number;
  /** Stop after this many actions (tests); unlimited when undefined. */
  maxActions?: number;
  /** How often the loop asks the policy for work. */
  tickMs?: number;
  /** How long `stop` waits for in-flight transactions before giving up on them. */
  drainMs?: number;
  /** How many ticks an `(action, actor)` pair sits out after `REFUSALS_BEFORE_COOLDOWN` refusals in a row. */
  cooldownTicks?: number;
  /** Back-off before each retry of a transient failure, before jitter; its length is the number of retries. */
  retryDelaysMs?: readonly number[];
  /**
   * Failures with no choice to report them against: `recover`, the policy, the reporter itself.
   * Defaults to stderr.
   */
  onError?: (context: string, error: RtgsError) => void;
}

/** Refusals in a row that put an `(action, actor)` pair on cool-down. */
export const REFUSALS_BEFORE_COOLDOWN = 3;

const DEFAULTS = { tickMs: 250, drainMs: 30_000, cooldownTicks: 40, retryDelaysMs: [500, 1_000, 2_000] };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** ±25%, so lanes that hit the same busy ledger don't retry in step. */
const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);

const keyOf = (choice: Choice): ExclusionKey => `${choice.action.name}:${choice.actor}`;

export class Engine {
  private readonly lanes: Map<string, Lane>;
  private readonly inFlight = new Set<Promise<void>>();
  /** Consecutive refusals per pair, and the tick each cooling pair is excluded until. */
  private readonly refusals = new Map<ExclusionKey, number>();
  private readonly cooling = new Map<ExclusionKey, number>();
  private ticks = 0;
  private dispatched = 0;
  private tokens: number;
  private refilledAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  /** Set once stopped: work still in flight past the drain no longer reports or refreshes. */
  private closed = false;
  private readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(readonly options: EngineOptions) {
    this.lanes = new Map(options.lanes.map((address) => [address, new Lane(address)]));
    this.tokens = this.capacity;
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  /** Runs `recover`, then the loop; resolves once stopped (or `maxActions` is reached) and drained. */
  async run(): Promise<void> {
    if (!this.starting) {
      this.starting = this.recover("start");
      await this.starting;
      if (!this.stopping) {
        this.refilledAt = Date.now();
        this.timer = setInterval(() => this.tick(), this.options.tickMs ?? DEFAULTS.tickMs);
        this.tick();
      }
    }
    await this.done;
  }

  /** Stops dispatching, drains in-flight work, runs `recover`. Safe to call twice. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  /** The bucket holds a second's worth of actions, and at least one. */
  private get capacity(): number {
    return Math.max(1, this.options.rate);
  }

  private async shutdown(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.starting;
    const drainMs = this.options.drainMs ?? DEFAULTS.drainMs;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = Promise.all(this.inFlight).then(() => true);
    const timedOut = new Promise<false>((resolve) => (drainTimer = setTimeout(() => resolve(false), drainMs)));
    const clean = await Promise.race([drained, timedOut]);
    clearTimeout(drainTimer);
    if (!clean) {
      this.error("stop", new RtgsError("transaction", "Not drained", `${this.inFlight.size} action(s) still in flight after ${drainMs} ms.`));
    }
    this.closed = true;
    // Only when started: a stop before `run` has nothing to undo, and the CLI never does that.
    if (this.starting) await this.recover("stop");
    this.resolveDone();
  }

  private tick(): void {
    if (this.stopping) return;
    this.ticks++;
    const { world, policy, reporter } = this.options;
    try {
      reporter.tick(world);
    } catch (e) {
      this.error("reporter.tick", toRtgsError(e));
    }

    for (const [key, until] of this.cooling) {
      if (this.ticks >= until) {
        this.cooling.delete(key);
        this.refusals.delete(key);
      }
    }
    const idle = [...this.lanes.values()].filter((lane) => lane.idle).map((lane) => lane.address);
    if (idle.length === 0) return;
    const excluded: ReadonlySet<ExclusionKey> = new Set(this.cooling.keys());

    let choices: Choice[];
    try {
      choices = policy.choose(world, idle, excluded);
    } catch (e) {
      this.error("policy.choose", toRtgsError(e));
      return;
    }

    this.refill();
    for (const choice of choices) {
      if (this.stopping) return;
      const lane = this.lanes.get(choice.actor);
      // Safety nets: one choice per idle lane, and nothing cooling down.
      if (!lane?.idle || excluded.has(keyOf(choice))) continue;
      if (this.tokens < 1) break;
      this.tokens--;
      this.dispatch(lane, choice);
      if (this.options.maxActions !== undefined && this.dispatched >= this.options.maxActions) {
        void this.stop();
        return;
      }
    }
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.refilledAt) / 1000) * this.options.rate);
    this.refilledAt = now;
  }

  private dispatch(lane: Lane, choice: Choice): void {
    this.dispatched++;
    const work = lane.run(() => this.execute(choice)).catch((e) => this.error("lane", toRtgsError(e)));
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /** Runs one choice to an outcome, reports it, then refreshes what it touched. Never rejects. */
  private async execute(choice: Choice): Promise<void> {
    const started = Date.now();
    let outcome: Outcome;
    try {
      outcome = { kind: "ok", tx: await this.attempt(choice) };
    } catch (e) {
      const kind = classify(e);
      outcome = { kind: kind === "refused" ? "refused" : "failed", error: toRtgsError(e) };
    }
    if (this.closed) return;
    this.report(choice, outcome, Date.now() - started);
    this.cooldown(choice, outcome);

    try {
      await this.options.world.refresh(choice.action.touches(choice.actor, choice.params));
    } catch (e) {
      if (!this.closed) this.report(choice, { kind: "failed", error: toRtgsError(e) }, 0);
    }
  }

  /** `action.run`, retried with back-off while it fails transiently. */
  private async attempt(choice: Choice): Promise<TxOutcome<unknown>> {
    const delays = this.options.retryDelaysMs ?? DEFAULTS.retryDelaysMs;
    for (let retry = 0; ; retry++) {
      try {
        return await choice.action.run(this.options.actors, choice.actor, choice.params);
      } catch (e) {
        const delay = delays[retry];
        if (delay === undefined || this.closed || classify(e) !== "transient") throw e;
        await sleep(jitter(delay));
      }
    }
  }

  private report(choice: Choice, outcome: Outcome, ms: number): void {
    try {
      this.options.reporter.result(choice, outcome, ms);
    } catch (e) {
      this.error("reporter.result", toRtgsError(e));
    }
  }

  private cooldown(choice: Choice, outcome: Outcome): void {
    const key = keyOf(choice);
    if (outcome.kind !== "refused") {
      this.refusals.delete(key);
      return;
    }
    const count = (this.refusals.get(key) ?? 0) + 1;
    this.refusals.set(key, count);
    if (count >= REFUSALS_BEFORE_COOLDOWN && !this.cooling.has(key)) {
      this.cooling.set(key, this.ticks + (this.options.cooldownTicks ?? DEFAULTS.cooldownTicks));
    }
  }

  /** Every module's `recover`, one after another; a failure is reported and the rest still run. */
  private async recover(when: "start" | "stop"): Promise<void> {
    for (const module of this.options.modules) {
      try {
        await module.recover?.(this.options.actors, this.options.world);
      } catch (e) {
        this.error(`recover ${module.group} (${when})`, toRtgsError(e));
      }
    }
  }

  private error(context: string, error: RtgsError): void {
    const onError = this.options.onError ?? ((c, e) => console.error(`[engine] ${c}: ${e.message}`));
    try {
      onError(context, error);
    } catch {
      // An error handler that throws has nowhere left to report to.
    }
  }
}
