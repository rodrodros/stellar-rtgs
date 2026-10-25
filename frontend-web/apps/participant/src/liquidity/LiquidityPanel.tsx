// The bank's liquidity: the cash token it holds on its trustline (ADR-0003) against its custody
// balance in the settlement contract (ADR-0004), with deposit and withdraw between them.
import type { Holding } from "@rtgs/core";
import { useSession } from "@rtgs/core/react";
import { useState } from "react";
import { useActingBank } from "../session/ActingBank.tsx";
import { useBankData } from "../session/BankData.tsx";
import { amountText, readAmount } from "../ui/format.ts";
import { TxStatus } from "../ui/TxStatus.tsx";
import { useTx } from "../ui/useTx.ts";

export function trustlineText(holding: Holding): string {
  if (!holding.exists) return "No trustline";
  if (holding.authorized) return "Authorized";
  if (holding.authorizedToMaintainLiabilities) return "Authorized to maintain liabilities only";
  return "Not authorized: the central bank must authorize it";
}

export function LiquidityPanel() {
  const session = useSession();
  const { actor } = useActingBank();
  const { view, holding, refresh } = useBankData();
  const [amount, setAmount] = useState("");
  const tx = useTx(refresh);
  const code = session.cashToken.code;

  const move = (kind: "deposit" | "withdraw") => {
    if (!actor) return;
    const parsed = readAmount(amount);
    if (!parsed.ok) return tx.fail(parsed.message);
    const shown = amountText(parsed.value, code);
    void tx.run(
      kind === "deposit" ? `Depositing ${shown}` : `Withdrawing ${shown}`,
      () => (kind === "deposit" ? actor.deposit(parsed.value) : actor.withdraw(parsed.value)),
      () => {
        setAmount("");
        return kind === "deposit" ? `Deposited ${shown} into your settlement balance.` : `Withdrew ${shown} to your trustline.`;
      },
    );
  };

  return (
    <section className="panel" aria-labelledby="liquidity-title">
      <h2 id="liquidity-title">Liquidity</h2>
      <dl className="figures">
        <div>
          <dt>Settlement balance</dt>
          <dd data-testid="settlement-balance">{view ? amountText(view.balance, code) : "…"}</dd>
        </div>
        <div>
          <dt>Cash token holding</dt>
          <dd data-testid="holding">{holding ? amountText(holding.balance, code) : "…"}</dd>
        </div>
        <div>
          <dt>Trustline</dt>
          <dd className={holding?.authorized ? "ok" : "warn"}>{holding ? trustlineText(holding) : "…"}</dd>
        </div>
      </dl>
      {holding && !holding.exists && actor && (
        <button
          type="button"
          disabled={!!tx.pending}
          onClick={() =>
            void tx.run("Opening the trustline", () => actor.openTrustline(), () => `Trustline for ${code} opened. The central bank must now authorize it.`)
          }
        >
          Open trustline
        </button>
      )}
      <form className="row" onSubmit={(e) => e.preventDefault()}>
        <label>
          Amount ({code})
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </label>
        <button type="button" className="primary" disabled={!actor || !!tx.pending || !holding?.authorized} onClick={() => move("deposit")}>
          Deposit
        </button>
        <button type="button" disabled={!actor || !!tx.pending} onClick={() => move("withdraw")}>
          Withdraw
        </button>
      </form>
      {holding && !holding.authorized && <p className="note">Deposits need an authorized trustline.</p>}
      <TxStatus state={tx} />
    </section>
  );
}
