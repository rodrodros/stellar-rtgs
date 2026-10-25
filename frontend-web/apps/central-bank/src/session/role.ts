// What the connected signer may do here. The central bank's entry points need the signer to be
// the contract's `central_bank()`; cash token administration needs the token's admin, which
// core decides (spec fact 3), so the app never compares the signer with the issuer itself.
import type { RtgsActor, RtgsSession, Signer, TokenAdmin } from "@rtgs/core";
import { useMemo } from "react";
import { useSession } from "@rtgs/core/react";
import { useAppSession } from "./AppSession.tsx";

export interface Role {
  signer: Signer | undefined;
  /** The signer is the contract's central bank. */
  isCentralBank: boolean;
  /** Entry points signed by the signer: any signer may run keeper actions. */
  actor: RtgsActor | undefined;
  /** Central bank entry points: set only when the signer is the central bank. */
  centralBank: RtgsActor | undefined;
  /** Cash token administration: set only when core accepts the signer as the token's admin. */
  tokenAdmin: TokenAdmin | undefined;
}

export function roleOf(session: RtgsSession, signer: Signer | undefined): Role {
  if (!signer) return { signer, isCentralBank: false, actor: undefined, centralBank: undefined, tokenAdmin: undefined };
  const actor = session.as(signer);
  const isCentralBank = signer.address === session.centralBank;
  let tokenAdmin: TokenAdmin | undefined;
  try {
    tokenAdmin = session.tokenAdmin(signer);
  } catch {
    tokenAdmin = undefined;
  }
  return { signer, isCentralBank, actor, centralBank: isCentralBank ? actor : undefined, tokenAdmin };
}

export function useRole(): Role {
  const session = useSession();
  const { signer } = useAppSession();
  return useMemo(() => roleOf(session, signer), [session, signer]);
}

/** Why a central bank action is unavailable, if it is. */
export function centralBankReason(role: Role): string | undefined {
  if (!role.signer) return "Connect a signer first";
  if (!role.isCentralBank) return "Only the central bank may do this";
  return undefined;
}

export function tokenAdminReason(role: Role): string | undefined {
  if (!role.signer) return "Connect a signer first";
  if (!role.tokenAdmin) return "Only the cash token's admin may do this";
  return undefined;
}
