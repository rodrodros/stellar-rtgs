import { ledgerUrl, txUrl } from "@rtgs/core";
import { useAppSession } from "../session/AppSession.tsx";

/** A transaction hash, linked to the network's explorer when it has one (none on devnet). */
export function TxLink(props: { hash: string }) {
  const { network } = useAppSession();
  const url = txUrl(network, props.hash);
  const text = <span className="mono" title={props.hash}>{props.hash.slice(0, 10)}…</span>;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    text
  );
}

export function LedgerLink(props: { ledger: number }) {
  const { network } = useAppSession();
  const url = ledgerUrl(network, props.ledger);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      ledger {props.ledger}
    </a>
  ) : (
    <>ledger {props.ledger}</>
  );
}
