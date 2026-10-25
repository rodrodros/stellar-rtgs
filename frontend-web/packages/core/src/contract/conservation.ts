// S1 (conservation) read in one go: the cash the settlement contract holds and the settlement
// balances it records, from a single getLedgerEntries call, so both sides come from the same
// ledger. Separate reads can straddle a deposit, a withdrawal or a repo's mint or burn, and
// then differ although S1 holds. Both contracts keep a balance under `Balance(address)` in
// persistent storage: the SAC as { amount, authorized, clawback }, the settlement contract as
// an i128 (`DataKey::Balance`).
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { toRtgsError } from "../errors.ts";
import type { TxContext } from "../tx.ts";

export interface ConservationRead {
  /** The ledger both sides were read at. */
  ledger: number;
  /** Cash tokens the settlement contract holds. */
  held: bigint;
  /** Each account's settlement balance; 0 for one with no entry. */
  balances: Map<string, bigint>;
  /** The sum of `balances`. */
  recorded: bigint;
  /** held - recorded: 0 when S1 holds. */
  difference: bigint;
  holds: boolean;
}

function balanceKey(contract: string, holder: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      durability: xdr.ContractDataDurability.persistent,
      key: nativeToScVal(["Balance", holder], { type: ["symbol", "address"] }),
    }),
  );
}

/** RPC answers up to 200 keys per call: the contract's holding plus 199 accounts. */
export const MAX_CONSERVATION_ACCOUNTS = 199;

/** One atomic read of what `contractId` holds of `sacId` and records for `accounts`. */
export async function readConservation(
  ctx: TxContext,
  contractId: string,
  sacId: string,
  accounts: readonly string[],
): Promise<ConservationRead> {
  const unique = [...new Set(accounts)];
  if (unique.length > MAX_CONSERVATION_ACCOUNTS) {
    throw new RangeError(`readConservation reads at most ${MAX_CONSERVATION_ACCOUNTS} accounts in one ledger, not ${unique.length}`);
  }
  let response;
  try {
    response = await ctx.server.getLedgerEntries(balanceKey(sacId, contractId), ...unique.map((a) => balanceKey(contractId, a)));
  } catch (e) {
    throw toRtgsError(e);
  }
  let held = 0n;
  const balances = new Map(unique.map((a) => [a, 0n]));
  for (const entry of response.entries) {
    if (entry.val.type !== "contractData") continue;
    const data = entry.val.value;
    const owner = Address.fromScAddress(data.contract).toString();
    const [, holder] = scValToNative(data.key) as [string, string];
    const value = scValToNative(data.val) as bigint | { amount: bigint };
    if (owner === sacId && holder === contractId) held = BigInt((value as { amount: bigint }).amount);
    else if (owner === contractId && balances.has(holder)) balances.set(holder, BigInt(value as bigint));
  }
  let recorded = 0n;
  for (const b of balances.values()) recorded += b;
  const difference = held - recorded;
  return { ledger: response.latestLedger, held, balances, recorded, difference, holds: difference === 0n };
}
