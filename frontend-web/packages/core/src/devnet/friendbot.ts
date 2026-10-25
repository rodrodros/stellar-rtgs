import { RtgsError } from "../errors.ts";
import type { RpcServer } from "../rpc.ts";

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
