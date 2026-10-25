// S1 (conservation) as the central bank can check it from outside: the cash the settlement
// contract holds against the settlement balances it records. A direct clawback from the
// contract, hazard H1 (integration/issuer-powers-hazard.sh), is the first thing that breaks it.
export interface Conservation {
  /** Cash tokens the settlement contract holds. */
  held: bigint;
  /** Sum of the settlement balances the contract records for every known account. */
  recorded: bigint;
  /** held - recorded: 0 when S1 holds. */
  difference: bigint;
  holds: boolean;
}

export function conservation(held: bigint, balances: Iterable<bigint>): Conservation {
  let recorded = 0n;
  for (const b of balances) recorded += b;
  const difference = held - recorded;
  return { held, recorded, difference, holds: difference === 0n };
}
