import { rpc } from "@stellar/stellar-sdk";
import { RtgsError, toRtgsError } from "./errors.ts";
import type { NetworkConfig } from "./network/networks.ts";

export type RpcServer = rpc.Server;

/**
 * Every RPC request gives up after this long. Without it a request the network never answers
 * hangs forever, and whatever awaits it (the event feed, a store refresh, a transaction)
 * stops with no error.
 */
export const RPC_TIMEOUT_MS = 30_000;

export function rpcServer(net: NetworkConfig): RpcServer {
  if (!net.rpcUrl) {
    throw new RtgsError("config", "No RPC URL", `Set the ${net.label} RPC URL (VITE_RTGS_${net.id.toUpperCase()}_RPC_URL).`);
  }
  return new rpc.Server(net.rpcUrl, { allowHttp: net.allowHttp, timeout: RPC_TIMEOUT_MS });
}

/**
 * Refuses an RPC that serves another network than `net` says, so a mistyped URL can't point
 * one network's session (and signers) at another.
 */
export async function assertNetwork(server: RpcServer, net: NetworkConfig): Promise<void> {
  let passphrase: string;
  try {
    passphrase = (await server.getNetwork()).passphrase;
  } catch (e) {
    throw toRtgsError(e);
  }
  if (passphrase !== net.passphrase) {
    throw new RtgsError(
      "network-mismatch",
      "Wrong network",
      `${net.rpcUrl} serves "${passphrase}", not ${net.label} ("${net.passphrase}").`,
    );
  }
}

export interface LedgerClock {
  sequence: number;
  /** The latest ledger's close time, in Unix seconds: the RTGS's clock. */
  closeTime: number;
}

export async function latestLedger(server: RpcServer): Promise<LedgerClock> {
  const latest = await server.getLatestLedger();
  return { sequence: latest.sequence, closeTime: Number(latest.closeTime) };
}
