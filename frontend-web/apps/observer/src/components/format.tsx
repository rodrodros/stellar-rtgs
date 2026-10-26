// Small display pieces every panel uses: amounts in the cash token, addresses by name, close
// times, and links to payment orders, transactions and the network's explorer.
import type { ReactNode } from "react";
import { CASH_DECIMALS, formatAmount, useSession } from "../core.ts";
import { useNav } from "../state/query.tsx";

/** `12325000000n` -> `"1,233"`: whole units, rounded half away from zero, thousands grouped. */
export function amountText(stroops: bigint): string {
  const unit = 10n ** BigInt(CASH_DECIMALS);
  const abs = stroops < 0n ? -stroops : stroops;
  const whole = (abs + unit / 2n) / unit;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return stroops < 0n && whole > 0n ? `-${grouped}` : grouped;
}

export function Amount(props: { value: bigint; signed?: boolean }) {
  const { cashToken } = useSession();
  const text = amountText(props.value);
  return (
    <span className="amount" title={formatAmount(props.value)}>
      {props.signed && props.value > 0n ? "+" : ""}
      {text} <span className="unit">{cashToken.code}</span>
    </span>
  );
}

export function useNameOf(): (address: string) => string {
  const session = useSession();
  return (address) => (address === session.contractId ? "Settlement contract" : session.registry.nameOf(address));
}

/** A bank by name, the central bank and the contract by role, anything else short and tagged. */
export function Address(props: { address: string }) {
  const session = useSession();
  const { address } = props;
  const nameOf = useNameOf();
  const role =
    address === session.centralBank ? "cb" : address === session.contractId ? "contract" : session.registry.get(address) ? "bank" : "unknown";
  return (
    <span className={`address address-${role}`} title={address}>
      {nameOf(address)}
      {role === "unknown" && <span className="tag">not in registry</span>}
    </span>
  );
}

export function formatTime(closedAt: number, withDate = false): string {
  return new Date(closedAt * 1000).toLocaleString(undefined, {
    ...(withDate ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function Time(props: { at: number; withDate?: boolean }) {
  return (
    <time dateTime={new Date(props.at * 1000).toISOString()} title={new Date(props.at * 1000).toISOString()}>
      {formatTime(props.at, props.withDate)}
    </time>
  );
}

export function PaymentLink(props: { id: bigint }) {
  const nav = useNav();
  return (
    <button type="button" className="link payment-link" onClick={() => nav.openPayment(props.id)}>
      #{props.id.toString()}
    </button>
  );
}

/** Opens the transaction's events, or every transaction of its ledger. */
export function TxLink(props: { hash: string; ledger: number }) {
  const nav = useNav();
  return (
    <span className="tx-ref">
      <button type="button" className="link mono" title={props.hash} onClick={() => nav.openTx(props.hash)}>
        tx {props.hash.slice(0, 8)}…
      </button>{" "}
      <button type="button" className="link" onClick={() => nav.openLedger(props.ledger)}>
        ledger {props.ledger.toLocaleString()}
      </button>
    </span>
  );
}

/** A link out to the network's block explorer, when core knows one (none on the devnet). */
export function ExplorerLink(props: { href: string | undefined; children: ReactNode }) {
  if (!props.href) return null;
  return (
    <a className="external" href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children} ↗
    </a>
  );
}

export function priorityLabel(priority: "urgent" | "normal"): string {
  return priority === "urgent" ? "Urgent" : "Normal";
}
