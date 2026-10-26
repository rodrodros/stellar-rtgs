// The simulation's status on the central bank's account (`rtgs.sim`), for the apps: the
// observer shows when the simulation is paused, or has died. While running it rewrites
// `running` as a heartbeat, so a status left at `running` with an old time means the process
// stopped without saying so.
import type { SimStatus } from "@rtgs/core";

export interface StatusPublisherOptions {
  /** Writes the status; the CLI routes it through the central bank's lane. */
  publish(status: SimStatus): Promise<unknown>;
  /** Ledger close time, Unix seconds. */
  now(): number;
  heartbeatMs?: number;
  onError?(error: unknown): void;
}

export interface StatusPublisher {
  /** Publishes `running`, then again every heartbeat. */
  start(): Promise<void>;
  /** Stops the heartbeat and publishes `state`. */
  end(state: "stopping" | "stopped"): Promise<void>;
}

export const HEARTBEAT_MS = 60_000;

export function createStatusPublisher(options: StatusPublisherOptions): StatusPublisher {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ended = false;

  async function publish(state: SimStatus["state"]): Promise<void> {
    try {
      await options.publish({ state, at: Math.floor(options.now()) });
    } catch (e) {
      // The next heartbeat tries again; a status write never stops the simulation.
      options.onError?.(e);
    }
  }

  return {
    async start() {
      if (ended) return;
      timer ??= setInterval(() => void publish("running"), options.heartbeatMs ?? HEARTBEAT_MS);
      await publish("running");
    },
    async end(state) {
      ended = true;
      clearInterval(timer);
      timer = undefined;
      await publish(state);
    },
  };
}
