// Cash token administration: authorizing holders, issuing and clawing back.
//
// Spec fact 3: today the central bank's own account is the cash token's issuer and so its SAC
// admin. This module is the only place that assumes it. An issuance controller contract
// holding the SAC admin role (README, "Decide who holds the cash token's SAC admin role")
// would replace this module and nothing else.
import { Address, Contract, nativeToScVal, Operation, StrKey } from "@stellar/stellar-sdk";
import { formatAmount } from "../amount.ts";
import { RtgsError } from "../errors.ts";
import type { Signer } from "../signer/signer.ts";
import { sendClassic, sendInvoke, type TxContext } from "../tx.ts";
import type { TxOutcome } from "../types.ts";
import type { CashToken } from "./cash-token.ts";

/** The central bank is the cash token's issuer: the account that issues it on the devnet. */
export function issuerFor(centralBank: string): string {
  return centralBank;
}

/** Whether `address` may administer the cash token (as its issuer and SAC admin). */
export function isTokenAdmin(address: string, token: CashToken): boolean {
  return address === token.issuer;
}

/** What clawback can and can't do (ADR-0006), for the central bank app to show. */
export const CLAWBACK_LIMITS =
  "Clawback is a recorded operator action for the cases the rulebook lists. It removes cash tokens a holder still holds; " +
  "it never undoes a final settlement, and it is refused against the settlement contract, whose holdings back every " +
  "bank's settlement balance. A payment sent in error is returned by a new payment from the payee.";

function assertPositive(amount: bigint): void {
  if (amount <= 0n) throw new RtgsError("token", "Invalid amount", "The amount must be greater than zero.");
}

export class TokenAdmin {
  private readonly sac: Contract;

  constructor(
    private readonly ctx: TxContext,
    readonly signer: Signer,
    readonly token: CashToken,
  ) {
    if (!isTokenAdmin(signer.address, token)) {
      throw new RtgsError(
        "unauthorized-signer",
        "Not the cash token's admin",
        `${signer.address} is not the issuer of ${token.code}; connect as the central bank.`,
      );
    }
    this.sac = new Contract(token.sacId);
  }

  /**
   * Authorizes (or deauthorizes) a holder: a bank's trustline through the classic flag, a
   * contract (the settlement contract) through the SAC's `set_authorized`.
   */
  async authorize(holder: string, authorized: boolean): Promise<TxOutcome> {
    if (StrKey.isValidContract(holder)) {
      const op = this.sac.call("set_authorized", new Address(holder).toScVal(), nativeToScVal(authorized));
      return { ...(await sendInvoke(this.ctx, this.signer, op, "sac")), value: undefined };
    }
    return sendClassic(this.ctx, this.signer, [
      Operation.setTrustLineFlags({ trustor: holder, asset: this.token.asset, flags: { authorized } }),
    ]);
  }

  /** Issues `amount` stroops of cash to a bank: a classic payment from the issuer. */
  async issue(to: string, amount: bigint): Promise<TxOutcome> {
    assertPositive(amount);
    if (StrKey.isValidContract(to)) {
      const op = this.sac.call("mint", new Address(to).toScVal(), nativeToScVal(amount, { type: "i128" }));
      return { ...(await sendInvoke(this.ctx, this.signer, op, "sac")), value: undefined };
    }
    return sendClassic(this.ctx, this.signer, [
      Operation.payment({ destination: to, asset: this.token.asset, amount: formatAmount(amount) }),
    ]);
  }

  /**
   * Claws back `amount` stroops a bank holds in its trustline (ADR-0006). Refused against any
   * contract, the settlement contract first of all: its holdings back the settlement balances,
   * so clawing them back would break conservation (S1) without touching any recorded payment.
   */
  async clawback(from: string, amount: bigint): Promise<TxOutcome> {
    assertPositive(amount);
    if (StrKey.isValidContract(from)) {
      throw new RtgsError("token", "Clawback refused", CLAWBACK_LIMITS);
    }
    return sendClassic(this.ctx, this.signer, [
      Operation.clawback({ asset: this.token.asset, from, amount: formatAmount(amount) }),
    ]);
  }
}
