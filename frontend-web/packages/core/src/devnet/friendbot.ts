import { Keypair, Operation } from "@stellar/stellar-sdk";
import { RtgsError, toRtgsError } from "../errors.ts";
import type { RpcServer } from "../rpc.ts";
import { keypairSigner } from "../signer/keypair.ts";
import { sendClassic, type TxContext } from "../tx.ts";

/**
 * Funds `address` through friendbot unless the account exists already; returns whether it
 * funded. Uses the URL from config, never the one RPC advertises (C-HB-073).
 */
export async function fundAccount(server: RpcServer, friendbotUrl: string, address: string): Promise<boolean> {
  try {
    await server.getAccount(address);
    return false;
  } catch {
    // Not found: fund it.
  }
  const url = new URL(friendbotUrl);
  url.searchParams.set("addr", address);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new RtgsError("rpc", "Friendbot unreachable", `${friendbotUrl} did not answer.`, { cause: e });
  }
  if (!response.ok) {
    // Funded meanwhile (a concurrent bootstrap): fine.
    try {
      await server.getAccount(address);
      return false;
    } catch {
      throw new RtgsError("rpc", "Friendbot refused", `Friendbot could not fund ${address} (HTTP ${response.status}).`);
    }
  }
  return true;
}

/**
 * Tops up an existing account's XLM, which friendbot won't do directly: it funds a throwaway
 * account, which then merges into `destination`. The throwaway account is the transaction's
 * source, so this never touches `destination`'s sequence number and can run while that account
 * is sending its own transactions. Resolves with the XLM merged, in stroops. If the merge
 * fails, the throwaway account is simply left behind.
 */
export async function refuelAccount(ctx: TxContext, friendbotUrl: string, destination: string): Promise<bigint> {
  const donor = Keypair.random();
  await fundAccount(ctx.server, friendbotUrl, donor.publicKey());
  let amount: bigint;
  try {
    amount = (await ctx.server.getAccountEntry(donor.publicKey())).balance;
  } catch (e) {
    throw toRtgsError(e);
  }
  const merge = () => sendClassic(ctx, keypairSigner(donor, ctx.net), [Operation.accountMerge({ destination })]);
  try {
    await merge();
  } catch {
    // A merge in the ledger that created the account is refused (`op_seqnum_too_far`); the next
    // ledger is about a second away on the devnet, five on the testnet.
    await new Promise((r) => setTimeout(r, ctx.net.id === "devnet" ? 2_000 : 7_000));
    await merge();
  }
  return amount;
}
