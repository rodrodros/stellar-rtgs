// The cash token: a classic asset used through its Stellar Asset Contract (ADR-0003).
import { Asset, Contract, Keypair, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { RtgsError, toRtgsError } from "../errors.ts";
import { simulateRead, type TxContext } from "../tx.ts";

// Stellar XDR `TrustLineFlags`.
const AuthorizedFlag = 1;
const AuthorizedToMaintainLiabilitiesFlag = 2;
const TrustlineClawbackEnabledFlag = 4;

export interface CashToken {
  /** The SAC's C-address. */
  sacId: string;
  /** e.g. "USD". */
  code: string;
  /** The issuing account. */
  issuer: string;
  asset: Asset;
}

/**
 * The settlement contract's cash token, read from its instance storage (`DataKey::Token`). The
 * contract has no `token()` view yet; this is the one place that relies on its storage layout,
 * and `fallback` (from config) covers a layout change.
 */
export async function tokenOfContract(
  ctx: TxContext,
  contractId: string,
  fallback?: string,
  instance?: xdr.ScContractInstance,
): Promise<string> {
  try {
    instance ??= await ctx.server.getContractInstance(contractId);
    for (const entry of instance.storage ?? []) {
      const key = scValToNative(entry.key) as unknown;
      if (Array.isArray(key) && key[0] === "Token") return String(scValToNative(entry.val));
    }
  } catch (e) {
    if (!fallback) throw toRtgsError(e);
  }
  if (fallback) return fallback;
  throw new RtgsError("config", "No cash token", `Couldn't read the cash token of ${contractId}; set it in config.`);
}

/** The asset a SAC wraps, from its `name()`: "USD:G...". */
export async function readCashToken(ctx: TxContext, sacId: string): Promise<CashToken> {
  const name = String(scValToNative(await simulateRead(ctx, new Contract(sacId).call("name"), "sac")));
  const [code, issuer] = name.split(":");
  if (!code || !issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
    throw new RtgsError("config", "Unexpected cash token", `The cash token's SAC wraps "${name}", not a classic asset.`);
  }
  const asset = new Asset(code, issuer);
  if (asset.contractId(ctx.net.passphrase) !== sacId) {
    throw new RtgsError("config", "Unexpected cash token", `${sacId} is not the SAC of ${name} on ${ctx.net.label}.`);
  }
  return { sacId, code, issuer, asset };
}

export interface Holding {
  /** The holder's cash token balance, in stroops (not the settlement balance). */
  balance: bigint;
  /** Whether a trustline (account) or SAC balance entry (contract) exists. */
  exists: boolean;
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  clawbackEnabled: boolean;
}

/** Reads cash token holdings: accounts' trustlines and contracts' SAC balances alike. */
export class CashTokenReader {
  constructor(
    private readonly ctx: TxContext,
    readonly token: CashToken,
  ) {}

  async holding(holder: string): Promise<Holding> {
    const none: Holding = { balance: 0n, exists: false, authorized: false, authorizedToMaintainLiabilities: false, clawbackEnabled: false };
    try {
      if (StrKey.isValidContract(holder)) {
        const entry = (await this.ctx.server.getSACBalance(holder, this.token.asset, this.ctx.net.passphrase)).balanceEntry;
        if (!entry) return none;
        return {
          balance: BigInt(entry.amount),
          exists: true,
          authorized: entry.authorized,
          authorizedToMaintainLiabilities: entry.authorizedToMaintainLiabilities ?? false,
          clawbackEnabled: entry.clawback,
        };
      }
      // Read the trustline itself: the SDK's getTrustline reports any failure, a network
      // error included, as "not found".
      const key = xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({
          accountId: Keypair.fromPublicKey(holder).xdrAccountId(),
          asset: this.token.asset.toTrustLineXdrObject(),
        }),
      );
      const [entry] = (await this.ctx.server.getLedgerEntries(key)).entries;
      if (!entry || entry.val.type !== "trustline") return none;
      const { balance, flags } = entry.val.trustLine;
      return {
        balance: BigInt(balance),
        exists: true,
        authorized: (flags & AuthorizedFlag) !== 0,
        authorizedToMaintainLiabilities: (flags & AuthorizedToMaintainLiabilitiesFlag) !== 0,
        clawbackEnabled: (flags & TrustlineClawbackEnabledFlag) !== 0,
      };
    } catch (e) {
      throw toRtgsError(e, "sac");
    }
  }

  async balance(holder: string): Promise<bigint> {
    return (await this.holding(holder)).balance;
  }
}
