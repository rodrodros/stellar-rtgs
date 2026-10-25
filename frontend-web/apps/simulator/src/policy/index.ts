// What to do next: weighted choice among the actions that apply, per profile. Ticket 06.
import type { ActionModule, Policy, Rng, Tuning } from "../types.ts";

export type ProfileName = "balanced" | "gridlock" | "calm";

export interface PolicyOptions {
  profile: ProfileName;
  modules: readonly ActionModule[];
  rng: Rng;
  tuning?: Partial<Tuning>;
  log?: (message: string) => void;
}

export function createPolicy(_options: PolicyOptions): Policy {
  throw new Error("createPolicy: not implemented (ticket 06)");
}
