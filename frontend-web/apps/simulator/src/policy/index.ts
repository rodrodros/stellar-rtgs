// What to do next: weighted choice among the actions that apply, per profile. Each idle actor
// draws among its role's actions that the contract implements, by the profile's weights,
// without replacement until one's `plan` applies; an actor with nothing to do sits the tick out.
import type { ActionDef, ActionModule, Choice, ExclusionKey, Policy, Rng, Role, Tuning, WorldView } from "../types.ts";
import { PROFILES, defaultTuning, type ProfileName } from "./profiles.ts";

export { PROFILES, PROFILE_NAMES, defaultTuning, type Profile, type ProfileName } from "./profiles.ts";

export interface PolicyOptions {
  profile: ProfileName;
  modules: readonly ActionModule[];
  rng: Rng;
  /** Overrides on top of `defaultTuning` and the profile's submit mix. */
  tuning?: Partial<Tuning>;
  log?: (message: string) => void;
}

export function createPolicy(options: PolicyOptions): Policy {
  const { rng, log } = options;
  const profile = PROFILES[options.profile];
  const weight = (a: ActionDef<any>) => profile.weights[a.name] ?? 0;
  const all = options.modules.flatMap((m) => m.actions);
  const actions = all.filter((a) => weight(a) > 0);
  // Resolved on the first `choose`, once the world knows the contract's config.
  let tuning: Tuning | undefined;
  let loggedDisabled = false;

  const enabled = (world: WorldView) => {
    const caps = world.capabilities();
    const isOn = (a: ActionDef<any>) => a.capability === undefined || caps[a.capability] === "available";
    if (!loggedDisabled) {
      loggedDisabled = true;
      // Every module's, whatever the profile: the log is about what the contract lacks.
      const off = all.filter((a) => !isOn(a)).map((a) => `${a.name} (${a.capability}: ${caps[a.capability!]})`);
      if (off.length > 0) log?.(`Disabled by capabilities: ${[...new Set(off)].join(", ")}`);
    }
    return actions.filter(isOn);
  };

  return {
    choose(world, idleActors, excluded = new Set<ExclusionKey>()) {
      tuning ??= {
        ...defaultTuning(world.config(), world.banks().length),
        submitMix: profile.submitMix,
        ...options.tuning,
      };
      const available = enabled(world);
      const choices: Choice[] = [];
      for (const actor of idleActors) {
        const role: Role = actor === world.centralBank ? "central-bank" : "bank";
        const candidates = available.filter((a) => a.role === role && !excluded.has(`${a.name}:${actor}`));
        while (candidates.length > 0) {
          const [action] = candidates.splice(drawIndex(rng, candidates.map(weight)), 1);
          const params = action!.plan({ world, rng, actor, tuning });
          if (params !== undefined) {
            choices.push({ action: action!, actor, params });
            break;
          }
        }
      }
      return choices;
    },
  };
}

/** An index drawn with probability proportional to its weight; weights are positive. */
function drawIndex(rng: Rng, weights: readonly number[]): number {
  let r = rng.next() * weights.reduce((sum, w) => sum + w, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}
