import { describe, expect, it } from "vitest";
import { BANK_1, BANK_2, bank, fakeActors, fakeWorld, payment } from "./fakes.ts";

describe("fakes", () => {
  it("derives the queued count and queued payments from the banks", () => {
    const p = payment({ from: BANK_1 });
    const world = fakeWorld();
    world.state.banks[0] = bank(BANK_1, { queues: { urgent: [], normal: [p] } });
    expect(world.queuedCount()).toBe(1);
    expect(world.queuedPayments(BANK_1)).toEqual([p]);
    expect(world.queuedPayments(BANK_2)).toEqual([]);
  });

  it("records actor calls", async () => {
    const actors = fakeActors();
    await actors.bank(BANK_1).deposit(5n);
    await actors.tokenAdmin.issue(BANK_2, 7n);
    expect(actors.calls).toEqual([
      { as: BANK_1, method: "deposit", args: [5n] },
      { as: "token-admin", method: "issue", args: [BANK_2, 7n] },
    ]);
    expect(actors.bank(BANK_1).address).toBe(BANK_1);
  });
});
