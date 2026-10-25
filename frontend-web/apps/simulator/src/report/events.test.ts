import { readFileSync } from "node:fs";
import type { RtgsEvent, RtgsEventBody } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { txFacts } from "./events.ts";

// Events a devnet run emitted, decoded by core's own tests: the shapes the reporter will see.
const recorded: RtgsEventBody[] = JSON.parse(
  readFileSync(new URL("../../../../packages/core/test/fixtures/devnet-events.json", import.meta.url), "utf8"),
  (_k, v: unknown) => (v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v),
).map((f: { expected: RtgsEventBody }) => f.expected);

/** The recorded events at these indexes, as one transaction's. */
function tx(...indexes: number[]): RtgsEvent[] {
  return indexes.map((i, n) => ({ ...recorded[i]!, eventId: `e${n}`, ledger: 100, closedAt: 1_000, txHash: "ab", contractId: "C" }) as RtgsEvent);
}

describe("txFacts", () => {
  it("sees a payment order settled at once", () => {
    const facts = txFacts(tx(1, 2)); // Submitted #0, Settled #0
    expect(facts.settled).toEqual({ atOnce: [0n], eagerClosure: [], offset: [] });
    expect(facts.queued).toEqual([]);
  });

  it("sees a payment order queued", () => {
    const facts = txFacts(tx(12)); // Submitted #4
    expect(facts.queued).toEqual([4n]);
    expect(facts.settled).toEqual({ atOnce: [], eagerClosure: [], offset: [] });
  });

  it("sees the eager closure release payment orders queued before", () => {
    const facts = txFacts(tx(7, 8)); // Deposited, Settled #1
    expect(facts.settled).toEqual({ atOnce: [], eagerClosure: [1n], offset: [] });
  });

  it("counts payment orders settled by an offset as offset, the submitted one included", () => {
    const facts = txFacts(tx(13, 14, 15, 16)); // Submitted #5, Offset [#4, #5], Settled #4, Settled #5
    expect(facts.settled).toEqual({ atOnce: [], eagerClosure: [], offset: [4n, 5n] });
    expect(facts.offsets).toEqual([[4n, 5n]]);
    expect(facts.queued).toEqual([]);
  });

  it("doesn't rely on the offset coming before its settlements", () => {
    const facts = txFacts(tx(13, 15, 16, 14));
    expect(facts.settled.offset).toEqual([4n, 5n]);
  });

  it("sees repos opened, repaid and penalised", () => {
    const facts = txFacts(tx(18, 19, 20, 21));
    expect(facts.repos.opened).toEqual([{ id: 0n, bank: "GAWMWVEMRI7VLBGTGFYE2HOZUZW3TVFJQT5GMTCYSCFWUWDPBNPDXQ3I", amount: 300_000_000n }]);
    expect(facts.repos.repaid).toEqual([
      { id: 0n, amount: 100_000_000n, outstanding: 200_000_000n },
      { id: 0n, amount: 200_000_000n, outstanding: 0n },
    ]);
    expect(facts.repos.penalised).toEqual([{ id: 0n, rateBps: 500 }]);
  });

  it("sees revocations and reprioritisations", () => {
    const facts = txFacts(tx(5, 6));
    expect(facts.reprioritised).toEqual([{ id: 1n, priority: "urgent" }]);
    expect(facts.revoked).toEqual([2n]);
  });

  it("finds nothing in a transaction without contract events", () => {
    const facts = txFacts([]);
    expect(facts.settled).toEqual({ atOnce: [], eagerClosure: [], offset: [] });
    expect(facts.queued).toEqual([]);
  });
});
