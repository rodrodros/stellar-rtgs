// The simulation's view of the RTGS: the session's store plus each bank's trustline. Ticket 02.
import type { RtgsSession } from "@rtgs/core";
import type { World } from "../types.ts";

export function createWorld(_session: RtgsSession, _banks: readonly { address: string; label: string }[]): World {
  throw new Error("createWorld: not implemented (ticket 02)");
}
