import { RtgsError, toRtgsError } from "@rtgs/core";
import type { TxOutcome } from "@rtgs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BANK_1, BANK_2, BANK_3, CB, fakeActors, fakeWorld, txOutcome } from "../../test/fakes.ts";
import type { ActionDef, ActionModule, Choice, ExclusionKey, Outcome, Policy, Reporter, Summary, WorldView } from "../types.ts";
import { Engine, REFUSALS_BEFORE_COOLDOWN } from "./index.ts";
import type { EngineOptions } from "./index.ts";

const LANES = [BANK_1, BANK_2, BANK_3, CB];

/** An action whose `run` does what the test says, and records the actor of every call. */
function action(run: (actor: string) => Promise<TxOutcome<unknown>> = async () => txOutcome(undefined)) {
  const calls: string[] = [];
  const def: ActionDef<null> = {
    name: "revoke",
    group: "payments",
    role: "bank",
    plan: () => null,
    run: (_actors, actor) => {
      calls.push(actor);
      return run(actor);
    },
    describe: () => "test",
    touches: (actor) => [actor],
  };
  return Object.assign(def, { calls });
}

/** A policy that chooses `def` for every idle actor (or as `script` says), and records its inputs. */
function policy(def: ActionDef<null>, script?: (idle: readonly string[], excluded: ReadonlySet<ExclusionKey>) => Choice[]) {
  const seen: { idle: string[]; excluded: ExclusionKey[] }[] = [];
  const p: Policy = {
    choose: (_world: WorldView, idle, excluded = new Set()) => {
      seen.push({ idle: [...idle], excluded: [...excluded] });
      return script ? script(idle, excluded) : idle.map((actor) => ({ action: def, actor, params: null }));
    },
  };
  return Object.assign(p, { seen });
}

function reporter() {
  const results: { actor: string; outcome: Outcome; ms: number }[] = [];
  let ticks = 0;
  const r: Reporter = {
    start: () => {},
    result: (choice, outcome, ms) => results.push({ actor: choice.actor, outcome, ms }),
    tick: () => void ticks++,
    stop: (): Summary => ({ elapsed: 0, counts: {}, settlements: { atOnce: 0, eagerClosure: 0, offset: 0 } }),
  };
  return Object.assign(r, { results, ticks: () => ticks });
}

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function engine(over: Partial<EngineOptions> & Pick<EngineOptions, "policy">) {
  const errors: string[] = [];
  const options: EngineOptions = {
    world: fakeWorld(),
    reporter: reporter(),
    actors: fakeActors(),
    modules: [],
    lanes: LANES,
    rate: 100,
    tickMs: 250,
    onError: (context, e) => errors.push(`${context}: ${e.title}`),
    ...over,
  };
  return Object.assign(new Engine(options), { errors });
}

const tick = (n = 1) => vi.advanceTimersByTimeAsync(250 * n);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Engine", () => {
  it("never has two actions in flight for one actor, and runs lanes concurrently", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<TxOutcome<unknown>>>>();
    let inFlight = 0;
    let most = 0;
    const def = action((actor) => {
      expect(pending.has(actor)).toBe(false);
      const d = deferred<TxOutcome<unknown>>();
      pending.set(actor, d);
      most = Math.max(most, ++inFlight);
      return d.promise.finally(() => {
        inFlight--;
        pending.delete(actor);
      });
    });
    const p = policy(def);
    const e = engine({ policy: p });
    void e.run();
    await tick(4);

    // Every lane started at once, and none started again while in flight.
    expect(def.calls).toEqual(LANES);
    expect(most).toBe(LANES.length);
    expect(p.seen).toHaveLength(1); // ticks with no idle lane don't ask the policy

    pending.get(BANK_2)!.resolve(txOutcome(undefined));
    await tick();
    expect(def.calls).toEqual([...LANES, BANK_2]);
    expect(p.seen.at(-1)!.idle).toEqual([BANK_2]);

    for (const d of pending.values()) d.resolve(txOutcome(undefined));
    await e.stop();
  });

  it("calls the reporter every tick", async () => {
    const r = reporter();
    const e = engine({ policy: policy(action()), reporter: r });
    void e.run();
    await tick(8);
    expect(r.ticks()).toBe(9); // the first tick runs at once
    await e.stop();
  });

  it("drops choices over the rate budget instead of queueing them", async () => {
    const def = action();
    const e = engine({ policy: policy(def), rate: 2 });
    void e.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(def.calls).toHaveLength(2); // a full bucket: one second's worth

    await vi.advanceTimersByTimeAsync(5_000);
    // Two a second from then on, whatever the four idle lanes would take.
    expect(def.calls.length).toBeGreaterThanOrEqual(11);
    expect(def.calls.length).toBeLessThanOrEqual(12);
    await e.stop();
  });

  it("stops after maxActions and resolves run", async () => {
    const def = action();
    const e = engine({ policy: policy(def), maxActions: 6 });
    const done = vi.fn();
    void e.run().then(done);
    await tick(10);
    expect(def.calls).toHaveLength(6);
    expect(done).toHaveBeenCalled();
  });

  it("dispatches nothing with maxActions 0", async () => {
    const def = action();
    const e = engine({ policy: policy(def), maxActions: 0 });
    await Promise.all([e.run(), tick()]);
    expect(def.calls).toHaveLength(0);
  });

  it("retries transient failures with back-off, then reports ok", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    let attempts = 0;
    const def = action(async () => {
      attempts++;
      if (attempts === 1) throw toRtgsError("tx_bad_seq");
      if (attempts === 2) throw toRtgsError("setting ContractComputeV0 is not present in the snapshot");
      return txOutcome("done");
    });
    const r = reporter();
    const e = engine({
      policy: policy(def, (idle) => (idle.includes(BANK_1) && attempts === 0 ? [{ action: def, actor: BANK_1, params: null }] : [])),
      reporter: r,
    });
    void e.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(3);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.outcome).toMatchObject({ kind: "ok", tx: { value: "done" } });
    expect(r.results[0]!.ms).toBe(1_500);
    await e.stop();
  });

  it("gives up after three retries and reports failed", async () => {
    const def = action(async () => {
      throw toRtgsError("tx_bad_seq");
    });
    const r = reporter();
    const e = engine({ policy: policy(def, (idle) => (def.calls.length === 0 && idle.includes(BANK_1) ? [{ action: def, actor: BANK_1, params: null }] : [])), reporter: r });
    void e.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(def.calls).toHaveLength(4);
    expect(r.results).toEqual([{ actor: BANK_1, outcome: { kind: "failed", error: expect.objectContaining({ title: "Sequence number out of date" }) }, ms: expect.any(Number) }]);
    await e.stop();
  });

  it("classifies outcomes: a race is refused, anything else failed, a thrown non-error too", async () => {
    const thrown: Record<string, unknown> = {
      [BANK_1]: toRtgsError("Error(Contract, #7)"),
      [BANK_2]: toRtgsError("Error(Contract, #1)"),
      [BANK_3]: new TypeError("x is undefined"),
    };
    const def = action(async (actor) => {
      if (actor in thrown) throw thrown[actor];
      return txOutcome(undefined);
    });
    const r = reporter();
    const e = engine({ policy: policy(def), reporter: r, maxActions: 4 });
    await Promise.all([e.run(), tick()]);
    const kinds = Object.fromEntries(r.results.map((x) => [x.actor, x.outcome.kind]));
    expect(kinds).toEqual({ [BANK_1]: "refused", [BANK_2]: "failed", [BANK_3]: "failed", [CB]: "ok" });
    expect(e.errors).toEqual([]);
  });

  it("cools a pair down after repeated refusals, passes it to the policy, then lets it back", async () => {
    const def = action(async () => {
      throw toRtgsError("Error(Contract, #7)");
    });
    // A careless policy that ignores `excluded`: the engine drops the choice anyway.
    const p = policy(def, (idle) => (idle.includes(BANK_1) ? [{ action: def, actor: BANK_1, params: null }] : []));
    const e = engine({ policy: p, lanes: [BANK_1], cooldownTicks: 8 });
    void e.run();
    await tick(REFUSALS_BEFORE_COOLDOWN - 1);
    expect(def.calls).toHaveLength(REFUSALS_BEFORE_COOLDOWN);

    await tick(4);
    expect(def.calls).toHaveLength(REFUSALS_BEFORE_COOLDOWN);
    expect(p.seen.at(-1)).toEqual({ idle: [BANK_1], excluded: [`revoke:${BANK_1}`] });

    await tick(4);
    expect(p.seen.at(-1)).toEqual({ idle: [BANK_1], excluded: [] });
    expect(def.calls).toHaveLength(REFUSALS_BEFORE_COOLDOWN + 1);
    await e.stop();
  });

  it("resets the refusal count on success", async () => {
    let n = 0;
    const def = action(async () => {
      n++;
      if (n % 3 === 0) return txOutcome(undefined);
      throw toRtgsError("Error(Contract, #7)");
    });
    const p = policy(def);
    const e = engine({ policy: p, lanes: [BANK_1] });
    void e.run();
    await tick(11);
    expect(def.calls).toHaveLength(12);
    expect(p.seen.every((s) => s.excluded.length === 0)).toBe(true);
    await e.stop();
  });

  it("recovers at start, and on stop drains in-flight work before recovering again", async () => {
    const recover = vi.fn(async () => {});
    const modules: ActionModule[] = [{ group: "token", actions: [], recover }];
    const d = deferred<TxOutcome<unknown>>();
    const def = action(() => d.promise);
    const r = reporter();
    const e = engine({ policy: policy(def, (idle) => (def.calls.length === 0 && idle.includes(BANK_1) ? [{ action: def, actor: BANK_1, params: null }] : [])), reporter: r, modules });
    const ran = vi.fn();
    void e.run().then(ran);
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(def.calls).toHaveLength(1);

    const stopped = vi.fn();
    const first = e.stop().then(stopped);
    const second = e.stop();
    await tick(4);
    expect(stopped).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(r.ticks()).toBe(1); // no more ticks once stopping

    d.resolve(txOutcome(undefined));
    await Promise.all([first, second]);
    expect(r.results.map((x) => x.outcome.kind)).toEqual(["ok"]);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(ran).toHaveBeenCalled();

    await e.stop();
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("gives up draining after drainMs, and drops late results", async () => {
    const def = action(() => new Promise(() => {}));
    const recover = vi.fn(async () => {});
    const r = reporter();
    const e = engine({ policy: policy(def), reporter: r, drainMs: 1_000, modules: [{ group: "token", actions: [], recover }] });
    void e.run();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = vi.fn();
    void e.stop().then(stopped);
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toHaveBeenCalled();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(e.errors).toEqual(["stop: Not drained"]);
  });

  it("reports recover failures without throwing, and still runs the other modules", async () => {
    const later = vi.fn(async () => {});
    const modules: ActionModule[] = [
      { group: "token", actions: [], recover: async () => Promise.reject(new RtgsError("token", "Trustline not authorized", "")) },
      { group: "credit", actions: [], recover: later },
    ];
    const def = action();
    const e = engine({ policy: policy(def), modules, maxActions: 1 });
    await Promise.all([e.run(), tick()]);
    expect(later).toHaveBeenCalledTimes(2);
    expect(e.errors).toEqual(["recover token (start): Trustline not authorized", "recover token (stop): Trustline not authorized"]);
    expect(def.calls).toHaveLength(1);
  });

  it("refreshes what an action touched, and survives a refresh that throws", async () => {
    const world = fakeWorld();
    let refreshes = 0;
    world.refresh = async (addresses) => {
      world.refreshed.push([...addresses]);
      if (++refreshes === 1) throw new Error("fetch failed");
    };
    const def = action();
    const r = reporter();
    const e = engine({ policy: policy(def), reporter: r, world, lanes: [BANK_1] });
    void e.run();
    await tick(2);
    expect(world.refreshed).toEqual([[BANK_1], [BANK_1], [BANK_1]]);
    expect(r.results.map((x) => x.outcome.kind)).toEqual(["ok", "failed", "ok", "ok"]);
    expect(def.calls).toHaveLength(3);
    await e.stop();
  });

  it("survives a policy or reporter that throws", async () => {
    let n = 0;
    const def = action();
    const p = policy(def, (idle) => {
      if (++n === 1) throw new Error("bad policy");
      return idle.map((actor) => ({ action: def, actor, params: null }));
    });
    const r = reporter();
    r.result = () => {
      throw new Error("bad reporter");
    };
    const e = engine({ policy: p, reporter: r, lanes: [BANK_1] });
    void e.run();
    await tick(2);
    expect(def.calls).toHaveLength(2);
    expect(e.errors[0]).toBe("policy.choose: Unexpected failure");
    expect(e.errors.slice(1)).toEqual(["reporter.result: Unexpected failure", "reporter.result: Unexpected failure"]);
    await e.stop();
  });

  it("drops choices for unknown or busy actors", async () => {
    const def = action(() => new Promise(() => {}));
    const p = policy(def, () => [
      { action: def, actor: "GSTRANGER", params: null },
      { action: def, actor: BANK_1, params: null },
      { action: def, actor: BANK_1, params: null },
    ]);
    const e = engine({ policy: p, drainMs: 0 });
    void e.run();
    await tick(3);
    expect(def.calls).toEqual([BANK_1]);
    await Promise.all([e.stop(), vi.advanceTimersByTimeAsync(0)]);
  });
});
