import { useSession } from "@rtgs/core/react";
import { CreditPanel } from "./credit/CreditPanel.tsx";
import { LiquidityPanel } from "./liquidity/LiquidityPanel.tsx";
import { Notices } from "./live/Notices.tsx";
import { PaymentHistory } from "./payments/PaymentHistory.tsx";
import { SubmitPayment } from "./payments/SubmitPayment.tsx";
import { QueuesPanel } from "./queues/QueuesPanel.tsx";
import { useActingBank } from "./session/ActingBank.tsx";
import { BankDataProvider, useBankData } from "./session/BankData.tsx";

export function Dashboard() {
  const session = useSession();
  const { signer } = useActingBank();
  if (!signer) {
    return (
      <p className="empty">
        {session.network.id === "devnet" ? "Choose a bank to act as." : "Connect the wallet of a participant's account."}
      </p>
    );
  }
  // Keyed on the bank, so switching banks starts every panel afresh.
  return (
    <BankDataProvider key={signer.address} address={signer.address}>
      <Heading />
      <Notices bank={signer.address} />
      <main className="grid">
        <LiquidityPanel />
        <SubmitPayment />
        <CreditPanel />
        <QueuesPanel />
        <PaymentHistory />
      </main>
    </BankDataProvider>
  );
}

function Heading() {
  const session = useSession();
  const { address, error } = useBankData();
  return (
    <>
      <h2 className="acting">
        {session.registry.nameOf(address)} <code className="meta">{address}</code>
      </h2>
      {error && (
        <p className="tx tx-error" role="alert">
          <strong>{error.title}</strong> {error.detail}
        </p>
      )}
    </>
  );
}
