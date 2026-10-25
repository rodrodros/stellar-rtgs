// The traffic profiles and the default tuning. A profile is a weight per action (the policy
// draws among the actions that apply, by these weights) and a submit mix (the submit action
// picks its shape by it). Actions whose `plan` only applies when something is due — a top-up
// below the floor, a reauthorization after the pause — get large weights: they act as
// priorities, and fall through to the rest when nothing is due.
import { DEFAULT_CASH } from "@rtgs/core";
import type { Config } from "@rtgs/core";
import type { ActionName, Tuning } from "../types.ts";

export type ProfileName = "balanced" | "gridlock" | "calm";

export const PROFILE_NAMES: readonly ProfileName[] = ["balanced", "gridlock", "calm"];

export interface Profile {
  /** Relative weight per action; an action absent or at 0 is never chosen. */
  weights: Partial<Record<ActionName, number>>;
  submitMix: Tuning["submitMix"];
}

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  // Mostly covered submits and deposits, regular queueing, occasional gridlock; some credit;
  // rare clawback and deauthorize.
  balanced: {
    weights: {
      submit: 12,
      deposit: 4,
      withdraw: 2,
      revoke: 1,
      reprioritise: 1.5,
      repay: 1,
      reauthorize: 20,
      issue: 10,
      setCollateral: 2,
      openRepo: 2,
      clawback: 0.3,
      deauthorize: 0.1,
    },
    submitMix: { covered: 6, uncovered: 3, gridlock: 1 },
  },
  // Queues, eager closure and offsets: uncovered and crossing submits, deposits to release
  // them, and repos to fund them. No token disruption.
  gridlock: {
    weights: {
      submit: 20,
      deposit: 5,
      revoke: 0.5,
      reprioritise: 1,
      repay: 0.5,
      reauthorize: 20,
      issue: 10,
      setCollateral: 2,
      openRepo: 4,
    },
    submitMix: { covered: 1, uncovered: 4, gridlock: 5 },
  },
  // Covered payments in and out of the contract, and the top-ups that keep it going.
  calm: {
    weights: { submit: 10, deposit: 4, withdraw: 3, issue: 10 },
    submitMix: { covered: 1, uncovered: 0, gridlock: 0 },
  },
};

/**
 * Amounts sized against the bootstrap's cash per bank (`DEFAULT_CASH`, 10,000 USD): payments
 * of 0.1–8% of it, a holding kept between 10% and 150%, collateral of 10–50%. The queue
 * headroom leaves a slot per other bank lane, since that many uncovered submissions can land
 * between two snapshots, and never asks for more than the queue holds.
 */
export function defaultTuning(config: Config, banks: number): Tuning {
  const pct = (n: bigint) => (DEFAULT_CASH * n) / 1_000n;
  return {
    paymentSize: { min: pct(1n), max: pct(80n) },
    queueHeadroom: Math.max(1, Math.min(config.queueCap - 1, Math.max(2, banks - 1))),
    holdingFloor: pct(100n),
    holdingCeiling: pct(1_500n),
    deauthorizeSecs: 20,
    collateral: { min: pct(100n), max: pct(500n) },
    submitMix: PROFILES.balanced.submitMix,
  };
}
