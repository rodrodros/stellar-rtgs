import type { Capability } from "@rtgs/core";

/** Whether to offer an entry point. "unknown" (the probe couldn't tell) is offered: the call itself will say. */
export const offered = (c: Capability): boolean => c !== "stub";

export const STUB_NOTE = "Not implemented in this contract version.";
