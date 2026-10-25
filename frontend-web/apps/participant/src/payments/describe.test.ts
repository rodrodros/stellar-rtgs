import type { PaymentRecord, QueueAnalysis, RtgsEvent } from "@rtgs/core";
import { describe, expect, it } from "vitest";
import { describeSubmit, expiryNote, headNote, settledVia } from "./describe.ts";

const head: PaymentRecord = { id: 4n, from: "GA", to: "GB", amount: 50_000_000n, priority: "normal", submittedAt: 0, status: "queued", steps: [] };
const settled = (id: bigint) => ({ type: "Settled", id }) as RtgsEvent;

describe("describeSubmit", () => {
  it("says whether the order settled at once or queued, and where", () => {
    expect(describeSubmit({ value: { id: 3n, disposition: "settled" }, events: [settled(3n)] }, "normal")).toBe("Payment order #3 settled at once.");
    expect(describeSubmit({ value: { id: 3n, disposition: "queued" }, events: [] }, "urgent", 2)).toBe(
      "Payment order #3 queued at position 2 in your urgent queue.",
    );
  });

  it("names the payment orders the eager closure released in the same transaction", () => {
    expect(describeSubmit({ value: { id: 5n, disposition: "settled" }, events: [settled(5n), settled(1n), settled(2n)] }, "normal")).toBe(
      "Payment order #5 settled at once. The eager closure also settled #1, #2.",
    );
  });
});

describe("headNote", () => {
  const analysis = (a: Partial<QueueAnalysis>): QueueAnalysis => ({ priority: "normal", length: 1, head, covered: false, expired: false, ...a });

  it("explains an uncovered head with its shortfall", () => {
    expect(headNote(analysis({ blockedBy: "uncovered" }), 20_000_000n, "USD")).toMatch(/^Blocked queue head: .* 3 USD more is needed/);
  });

  it("explains a normal head waiting behind urgent orders", () => {
    expect(headNote(analysis({ blockedBy: "urgent-queued", covered: true }), 0n)).toBe("Waits behind your urgent payment orders, which go first.");
  });

  it("says nothing for an empty queue", () => {
    expect(headNote({ priority: "urgent", length: 0, covered: false, expired: false }, 0n)).toBeUndefined();
  });
});

describe("expiryNote", () => {
  it("follows the expire capability once the expiry has passed", () => {
    expect(expiryNote(100, 50, "available")).toEqual({ past: false, text: "Expires" });
    expect(expiryNote(100, 100, "stub").text).toBe("Past expiry; not enforced by this contract version");
    expect(expiryNote(100, 120, "available").text).toBe("Past expiry; a keeper may reject it");
  });
});

describe("settledVia", () => {
  const step = (extra: object) => ({ steps: [{ kind: "settled" as const, eventId: "1", ledger: 1, closedAt: 1, txHash: "t", ...extra }] });
  it("reads how the order settled from its lifecycle", () => {
    const name = (a: string) => (a === "GB" ? "Bank 2" : a);
    expect(settledVia(step({ via: "at-once" }), name)).toBe("at once");
    expect(settledVia(step({ via: "offset" }), name)).toBe("in an offset");
    expect(settledVia(step({ via: "eager-closure", trigger: { type: "Deposited", actor: "GB" } }), name)).toBe("released by Bank 2's deposit");
    expect(settledVia({ steps: [] }, name)).toBeUndefined();
  });
});
