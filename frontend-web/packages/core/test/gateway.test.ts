import { describe, expect, it } from "vitest";
import { latestId, mapLimit } from "../src/contract/gateway.ts";
import { toConfig, toPayment } from "../src/contract/convert.ts";
import { A, B } from "./helpers.ts";

describe("latestId", () => {
  it.each([0n, 1n, 2n, 7n, 8n, 1000n])("finds %d with logarithmically many probes", async (last) => {
    let probes = 0;
    const found = await latestId(async (id) => {
      probes += 1;
      return id <= last;
    });
    expect(found).toBe(last);
    expect(probes).toBeLessThanOrEqual(2 * (Math.log2(Number(last) + 1) + 2));
  });

  it("returns undefined when nothing was issued", async () => {
    expect(await latestId(async () => false)).toBeUndefined();
  });
});

describe("mapLimit", () => {
  it("keeps order and the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});

describe("conversion from the bindings' shapes", () => {
  it("converts a payment from the bindings and from raw scValToNative", () => {
    const bindings = toPayment({
      id: 3n,
      from: A,
      to: B,
      amount: 10n,
      priority: { tag: "Urgent", values: undefined },
      submitted_at: 1800000000n,
      status: { tag: "Settled", values: undefined },
      settled_at: 1800000005n,
    });
    expect(bindings).toEqual({ id: 3n, from: A, to: B, amount: 10n, priority: "urgent", submittedAt: 1800000000, status: "settled", settledAt: 1800000005 });
    const raw = toPayment({ id: 3n, from: A, to: B, amount: 10n, priority: ["Normal"], submitted_at: 1n, status: ["Queued"], settled_at: undefined });
    expect(raw).toMatchObject({ priority: "normal", status: "queued" });
    expect(raw.settledAt).toBeUndefined();
  });

  it("converts the config", () => {
    expect(toConfig({ queue_cap: 16, expiry_secs: 86400n, repo_term_secs: 86400n, penalty_rate_bps: 500 })).toEqual({
      queueCap: 16,
      expirySecs: 86400,
      repoTermSecs: 86400,
      penaltyRateBps: 500,
    });
  });
});
