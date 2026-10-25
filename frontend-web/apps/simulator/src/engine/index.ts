// The loop: one serial lane per signer, a rate budget, retries, outcome classification and a
// graceful stop. Ticket 01.
import type { ActionModule, Actors, Policy, Reporter, World } from "../types.ts";

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
}

export class Engine {
  constructor(readonly options: EngineOptions) {}

  /** Runs `recover`, then the loop; resolves once stopped (or `maxActions` is reached) and drained. */
  async run(): Promise<void> {
    throw new Error("Engine.run: not implemented (ticket 01)");
  }

  /** Stops dispatching, drains in-flight work, runs `recover`. Safe to call twice. */
  async stop(): Promise<void> {
    throw new Error("Engine.stop: not implemented (ticket 01)");
  }
}
