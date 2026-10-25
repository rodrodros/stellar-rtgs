// The observer's state in the URL query, so a view can be shared or put on a demo screen:
// `?network=testnet&contract=C…&from=12345&payment=42&tx=ab…`.
import { parseStart, type StartChoice } from "./retention.ts";

export interface ObserverQuery {
  /** As written in the URL; the app checks it against the networks this build offers. */
  network?: string;
  contract?: string;
  from: StartChoice;
  /** The payment order whose lifecycle is open. */
  payment?: bigint;
  /** The transaction whose events are open. */
  tx?: string;
}

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const TX_HASH = /^[0-9a-f]{64}$/i;

export function isContractId(text: string): boolean {
  return CONTRACT_ID.test(text);
}

export function parseQuery(search: string): ObserverQuery {
  const p = new URLSearchParams(search);
  const query: ObserverQuery = { from: parseStart(p.get("from")) };
  const network = p.get("network");
  if (network) query.network = network;
  const contract = p.get("contract")?.trim();
  if (contract && isContractId(contract)) query.contract = contract;
  const payment = p.get("payment");
  if (payment && /^\d+$/.test(payment)) query.payment = BigInt(payment);
  const tx = p.get("tx");
  if (tx && TX_HASH.test(tx)) query.tx = tx.toLowerCase();
  return query;
}

export function formatQuery(query: ObserverQuery): string {
  const p = new URLSearchParams();
  if (query.network) p.set("network", query.network);
  if (query.contract) p.set("contract", query.contract);
  if (query.from !== "retention") p.set("from", String(query.from));
  if (query.payment !== undefined) p.set("payment", query.payment.toString());
  if (query.tx) p.set("tx", query.tx);
  const text = p.toString();
  return text ? `?${text}` : "";
}
