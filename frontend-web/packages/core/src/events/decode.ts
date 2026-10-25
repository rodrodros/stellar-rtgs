// Decodes contract events into typed domain events. The layout follows each `#[contractevent]`
// in contracts/settlement/src/lib.rs: topic 0 is the event's snake_case name, then the
// `#[topic]` fields; the other fields are the data, as a map. Anything unexpected becomes an
// `Unknown` event rather than an exception, since the contract is still changing.
import { Address, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type { EventMeta, FeedEvent, Priority, RtgsEvent, RtgsEventBody, TokenEvent } from "../types.ts";

type Kind = "address" | "u64" | "i128" | "u32" | "priority" | "u64vec";

interface Schema {
  type: Exclude<RtgsEventBody["type"], "Unknown">;
  topics: [string, Kind][];
  data: [string, Kind][];
}

/** Every settlement event: name -> its topic and data fields, in the contract's field order. */
export const EVENT_SCHEMAS: Readonly<Record<string, Schema>> = {
  deposited: { type: "Deposited", topics: [["bank", "address"]], data: [["amount", "i128"]] },
  withdrawn: { type: "Withdrawn", topics: [["bank", "address"]], data: [["amount", "i128"]] },
  submitted: {
    type: "Submitted",
    topics: [["id", "u64"]],
    data: [["from", "address"], ["to", "address"], ["amount", "i128"], ["priority", "priority"]],
  },
  settled: {
    type: "Settled",
    topics: [["id", "u64"]],
    data: [["from", "address"], ["to", "address"], ["amount", "i128"]],
  },
  offset: { type: "Offset", topics: [], data: [["ids", "u64vec"]] },
  revoked: { type: "Revoked", topics: [["id", "u64"]], data: [] },
  reprioritised: { type: "Reprioritised", topics: [["id", "u64"]], data: [["priority", "priority"]] },
  expired: { type: "Expired", topics: [["id", "u64"]], data: [] },
  collateral_set: { type: "CollateralSet", topics: [["bank", "address"]], data: [["value", "i128"]] },
  repo_opened: { type: "RepoOpened", topics: [["id", "u64"]], data: [["bank", "address"], ["amount", "i128"]] },
  repo_repaid: { type: "RepoRepaid", topics: [["id", "u64"]], data: [["amount", "i128"], ["outstanding", "i128"]] },
  repo_penalised: { type: "RepoPenalised", topics: [["id", "u64"]], data: [["rate_bps", "u32"]] },
};

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** `{ tag: "Urgent" }` (bindings), `["Urgent"]` (raw ScVal) or `"Urgent"` -> `"urgent"`. */
export function toPriority(value: unknown): Priority {
  const tag =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value[0]
        : (value as { tag?: unknown } | null)?.tag;
  if (tag === "Urgent" || tag === "urgent") return "urgent";
  if (tag === "Normal" || tag === "normal") return "normal";
  throw new Error(`not a priority: ${String(tag)}`);
}

function convert(value: unknown, kind: Kind): unknown {
  switch (kind) {
    case "address":
      if (typeof value !== "string") throw new Error("not an address");
      return value;
    case "u64":
    case "i128":
      if (typeof value !== "bigint" && typeof value !== "number") throw new Error("not an integer");
      return BigInt(value);
    case "u32":
      if (typeof value !== "number") throw new Error("not a u32");
      return value;
    case "priority":
      return toPriority(value);
    case "u64vec":
      if (!Array.isArray(value)) throw new Error("not a vec");
      return value.map((v) => BigInt(v as bigint));
  }
}

function native(v: xdr.ScVal): unknown {
  return scValToNative(v);
}

/** Decodes one settlement event body from its topics and data. Never throws. */
export function decodeBody(topics: xdr.ScVal[], data: xdr.ScVal): RtgsEventBody {
  const rawTopics = topics.map(native);
  const rawData = native(data);
  const name = typeof rawTopics[0] === "string" ? rawTopics[0] : undefined;
  const schema = name === undefined ? undefined : EVENT_SCHEMAS[name];
  const unknown = (): RtgsEventBody => ({
    type: "Unknown",
    ...(name === undefined ? {} : { name }),
    topics: rawTopics,
    value: rawData,
  });
  if (!schema || rawTopics.length !== 1 + schema.topics.length) return unknown();
  try {
    const body: Record<string, unknown> = { type: schema.type };
    schema.topics.forEach(([field, kind], i) => {
      body[camel(field)] = convert(rawTopics[i + 1], kind);
    });
    // `data_format = "map"` is the default; accept a vec or a lone value too.
    schema.data.forEach(([field, kind], i) => {
      let value: unknown;
      if (Array.isArray(rawData)) value = rawData[i];
      else if (rawData !== null && typeof rawData === "object") value = (rawData as Record<string, unknown>)[field];
      else if (schema.data.length === 1) value = rawData;
      body[camel(field)] = convert(value, kind);
    });
    return body as RtgsEventBody;
  } catch {
    return unknown();
  }
}

/** Decodes a Stellar Asset Contract event (CAP-67 layout, with older layouts tolerated). */
export function decodeTokenBody(topics: xdr.ScVal[], data: xdr.ScVal): Omit<TokenEvent, keyof EventMeta> {
  const raw = topics.map(native);
  const action = typeof raw[0] === "string" ? raw[0] : "unknown";
  const addresses = topics
    .slice(1)
    .filter((t) => t.type === "scvAddress")
    .map((t) => Address.fromScVal(t).toString());
  const asset = topics.slice(1).find((t) => t.type === "scvString");
  const value = native(data);
  const event: Omit<TokenEvent, keyof EventMeta> = { type: "Token", action };
  if (asset) event.asset = String(native(asset));
  const amount =
    typeof value === "bigint"
      ? value
      : value && typeof value === "object" && typeof (value as { amount?: unknown }).amount === "bigint"
        ? (value as { amount: bigint }).amount
        : undefined;
  if (amount !== undefined) event.amount = amount;
  if (typeof value === "boolean") event.authorized = value;
  switch (action) {
    case "transfer":
      if (addresses[0]) event.from = addresses[0];
      if (addresses[1]) event.to = addresses[1];
      break;
    case "mint":
      if (addresses.length) event.to = addresses[addresses.length - 1]!;
      break;
    default:
      // burn, clawback, set_authorized, ...: the holder is the last address.
      if (addresses.length) event.from = addresses[addresses.length - 1]!;
  }
  return event;
}

export function decodeEvent(meta: EventMeta, topics: xdr.ScVal[], data: xdr.ScVal): RtgsEvent {
  return { ...meta, ...decodeBody(topics, data) };
}

/** Decodes an event from `contractId`: settlement events from the settlement contract, else token. */
export function decodeFeedEvent(
  meta: EventMeta,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  settlementId: string,
): FeedEvent {
  if (meta.contractId === settlementId) return decodeEvent(meta, topics, data);
  return { ...meta, ...decodeTokenBody(topics, data) };
}

/**
 * RPC's event id: the TOID of (ledger, transaction order, operation index), 19 digits, then
 * the event's index within the operation, 10 digits. It orders events.
 */
export function eventId(ledger: number, txOrder: number, opIndex: number, eventIndex: number): string {
  const toid = (BigInt(ledger) << 32n) | (BigInt(txOrder) << 12n) | BigInt(opIndex);
  return `${toid.toString().padStart(19, "0")}-${eventIndex.toString().padStart(10, "0")}`;
}

/** The C-address of a contract event's emitter. */
export function contractIdOf(event: xdr.ContractEvent): string {
  return event.contractId ? StrKey.encodeContract(Buffer.from(event.contractId.value)) : "";
}
