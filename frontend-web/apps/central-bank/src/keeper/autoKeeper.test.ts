import { describe, expect, it, vi } from "vitest";
import { AutoKeeper, type KeeperResult } from "./autoKeeper.ts";

function setup(work = { payments: [1n, 2n], repos: [7n] }) {
  const results: KeeperResult[] = [];
  const deps = {
    due: vi.fn(() => work),
    expire: vi.fn(async (_id: bigint) => {}),
    convertOverdue: vi.fn(async (_id: bigint) => {}),
    onResult: (r: KeeperResult) => results.push(r),
  };
  return { deps, results, keeper: new AutoKeeper(deps, 2) };
}

describe("AutoKeeper", () => {
  it("does nothing until started", async () => {
    const { deps, keeper } = setup();
    await keeper.tick();
    expect(deps.due).not.toHaveBeenCalled();
  });

  it("expires the due payment orders and converts the overdue repos, one at a time", async () => {
    const { deps, keeper, results } = setup();
    keeper.start();
    await keeper.tick();
    expect(deps.expire.mock.calls).toEqual([[1n], [2n]]);
    expect(deps.convertOverdue.mock.calls).toEqual([[7n]]);
    expect(results.map((r) => r.kind)).toEqual(["expired", "expired", "converted"]);
  });

  it("doesn't start a pass while one is in flight", async () => {
    const { deps, keeper } = setup({ payments: [1n], repos: [] });
    let release!: () => void;
    deps.expire.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    keeper.start();
    const first = keeper.tick();
    await keeper.tick();
    expect(deps.expire).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("backs off from an id that failed, then retries it", async () => {
    const { deps, keeper, results } = setup({ payments: [1n], repos: [] });
    deps.expire.mockRejectedValueOnce(new Error("Error(Contract, #9)"));
    keeper.start();
    await keeper.tick(); // fails
    await keeper.tick(); // skipped: within the back-off
    expect(deps.expire).toHaveBeenCalledTimes(1);
    await keeper.tick(); // retried
    expect(deps.expire).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.kind)).toEqual(["failed", "expired"]);
  });

  it("stops mid-pass when stopped", async () => {
    const { deps, keeper } = setup();
    deps.expire.mockImplementationOnce(async () => keeper.stop());
    keeper.start();
    await keeper.tick();
    expect(deps.expire).toHaveBeenCalledTimes(1);
    expect(deps.convertOverdue).not.toHaveBeenCalled();
  });
});
