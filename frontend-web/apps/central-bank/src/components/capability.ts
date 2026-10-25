import type { Capabilities, EntryPoint } from "@rtgs/core";

export const NOT_IMPLEMENTED = "Not implemented by this contract yet";

/** Why an entry point can't be used: only a stub disables it; "unknown" stays usable. */
export function capabilityReason(caps: Capabilities, entryPoint: EntryPoint): string | undefined {
  return caps[entryPoint] === "stub" ? NOT_IMPLEMENTED : undefined;
}

/** The first reason that applies. */
export function firstReason(...reasons: (string | undefined | false)[]): string | undefined {
  return reasons.find((r): r is string => typeof r === "string" && r.length > 0);
}
