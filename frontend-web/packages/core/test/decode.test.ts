import { contract, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeBody, decodeTokenBody, EVENT_SCHEMAS, eventId } from "../src/events/decode.ts";
import { A, addr, B, i128, map, priority, sym, u32, u64, wasm, CB } from "./helpers.ts";

describe("settlement event decoding", () => {
  const cases: [string, xdr.ScVal[], xdr.ScVal, object][] = [
    ["deposited", [sym("deposited"), addr(A)], map({ amount: i128(600) }), { type: "Deposited", bank: A, amount: 600n }],
    ["withdrawn", [sym("withdrawn"), addr(A)], map({ amount: i128(5) }), { type: "Withdrawn", bank: A, amount: 5n }],
    [
      "submitted",
      [sym("submitted"), u64(7)],
      map({ from: addr(A), to: addr(B), amount: i128(100), priority: priority("Urgent") }),
      { type: "Submitted", id: 7n, from: A, to: B, amount: 100n, priority: "urgent" },
    ],
    [
      "settled",
      [sym("settled"), u64(7)],
      map({ from: addr(A), to: addr(B), amount: i128(100) }),
      { type: "Settled", id: 7n, from: A, to: B, amount: 100n },
    ],
    ["offset", [sym("offset")], map({ ids: xdr.ScVal.scvVec([u64(1), u64(3)]) }), { type: "Offset", ids: [1n, 3n] }],
    ["revoked", [sym("revoked"), u64(2)], map({}), { type: "Revoked", id: 2n }],
    [
      "reprioritised",
      [sym("reprioritised"), u64(2)],
      map({ priority: priority("Normal") }),
      { type: "Reprioritised", id: 2n, priority: "normal" },
    ],
    ["expired", [sym("expired"), u64(2)], map({}), { type: "Expired", id: 2n }],
    ["collateral_set", [sym("collateral_set"), addr(A)], map({ value: i128(0) }), { type: "CollateralSet", bank: A, value: 0n }],
    [
      "repo_opened",
      [sym("repo_opened"), u64(1)],
      map({ bank: addr(A), amount: i128(50) }),
      { type: "RepoOpened", id: 1n, bank: A, amount: 50n },
    ],
    [
      "repo_repaid",
      [sym("repo_repaid"), u64(1)],
      map({ amount: i128(20), outstanding: i128(30) }),
      { type: "RepoRepaid", id: 1n, amount: 20n, outstanding: 30n },
    ],
    ["repo_penalised", [sym("repo_penalised"), u64(1)], map({ rate_bps: u32(500) }), { type: "RepoPenalised", id: 1n, rateBps: 500 }],
  ];

  it.each(cases)("decodes %s", (_name, topics, data, expected) => {
    expect(decodeBody(topics, data)).toEqual(expected);
  });

  it("covers all 12 events", () => {
    expect(Object.keys(EVENT_SCHEMAS)).toHaveLength(12);
  });

  it("turns an unknown or malformed event into Unknown instead of throwing", () => {
    expect(decodeBody([sym("upgraded")], xdr.ScVal.scvVoid())).toMatchObject({ type: "Unknown", name: "upgraded" });
    expect(decodeBody([sym("deposited"), addr(A)], map({ amount: sym("oops") }))).toMatchObject({ type: "Unknown" });
    expect(decodeBody([sym("deposited")], map({}))).toMatchObject({ type: "Unknown" });
    expect(decodeBody([], xdr.ScVal.scvVoid())).toMatchObject({ type: "Unknown" });
  });

  it("matches every event the deployed Wasm's spec declares (drift guard)", () => {
    const declared = contract.Spec.fromWasm(wasm()).events();
    expect(declared.length).toBeGreaterThan(0);
    for (const ev of declared) {
      const name = ev.prefixTopics.map(String)[0]!;
      const schema = EVENT_SCHEMAS[name];
      expect(schema, `event ${name}`).toBeDefined();
      const topicParams = ev.params.filter((p) => p.location.name === "scSpecEventParamLocationTopicList").map((p) => String(p.name));
      const dataParams = ev.params.filter((p) => p.location.name === "scSpecEventParamLocationData").map((p) => String(p.name));
      expect(schema!.topics.map(([f]) => f), `${name} topics`).toEqual(topicParams);
      expect(schema!.data.map(([f]) => f), `${name} data`).toEqual(dataParams);
      expect(ev.dataFormat.name, `${name} data format`).toBe("scSpecEventDataFormatMap");
    }
  });
});

describe("token event decoding (CAP-67)", () => {
  const asset = xdr.ScVal.scvString(`USD:${CB}`);
  it("decodes transfer, mint, clawback and set_authorized", () => {
    expect(decodeTokenBody([sym("transfer"), addr(A), addr(B), asset], i128(9))).toMatchObject({
      action: "transfer",
      from: A,
      to: B,
      amount: 9n,
      asset: `USD:${CB}`,
    });
    expect(decodeTokenBody([sym("mint"), addr(A), asset], i128(9))).toMatchObject({ action: "mint", to: A, amount: 9n });
    expect(decodeTokenBody([sym("mint"), addr(CB), addr(A), asset], i128(9))).toMatchObject({ to: A });
    expect(decodeTokenBody([sym("clawback"), addr(A), asset], i128(3))).toMatchObject({ action: "clawback", from: A });
    expect(decodeTokenBody([sym("set_authorized"), addr(A), asset], xdr.ScVal.scvBool(false))).toMatchObject({
      action: "set_authorized",
      from: A,
      authorized: false,
    });
  });

  it("reads a muxed transfer's amount from its map", () => {
    expect(decodeTokenBody([sym("transfer"), addr(A), addr(B), asset], map({ amount: i128(4), to_muxed_id: u64(1) })).amount).toBe(4n);
  });
});

describe("event ids", () => {
  it("formats RPC's TOID-based ids, which sort in ledger order", () => {
    expect(eventId(96, 1, 0, 0)).toBe("0000000412316864512-0000000000");
    expect(eventId(96, 1, 0, 1) > eventId(96, 1, 0, 0)).toBe(true);
    expect(eventId(97, 1, 0, 0) > eventId(96, 9, 0, 5)).toBe(true);
  });
});
