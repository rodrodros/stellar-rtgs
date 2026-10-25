import type { Env } from "@rtgs/core";

/** The build's VITE_RTGS_* settings, which core reads (see the workspace's .env.example). */
export const buildEnv: Env = import.meta.env;
