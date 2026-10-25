// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allAvailable } from "../src/capabilities.ts";
import type { SystemSnapshot } from "../src/model/store.ts";
import { RtgsProvider, useCapabilities, useEvents, useLedgerClock, useSnapshot } from "../src/react/index.tsx";
import type { RtgsSession } from "../src/session.ts";
import { meta } from "./helpers.ts";

afterEach(cleanup);

function fakeSession() {
  let snapshot = {
    status: "ready",
    queuedCount: 2,
    events: [] as SystemSnapshot["events"],
    ledger: { sequence: 10, closeTime: 1000 },
  } as unknown as SystemSnapshot;
  const listeners = new Set<() => void>();
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const release = vi.fn();
  const session = { capabilities: { ...allAvailable(), expire: "stub" }, store: vi.fn(() => ({ store, release })) };
  return {
    session: session as unknown as RtgsSession,
    release,
    set(patch: Partial<SystemSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const l of listeners) l();
    },
  };
}

function View() {
  const queued = useSnapshot((s) => s.queuedCount);
  const caps = useCapabilities();
  const deposits = useEvents((e) => e.type === "Deposited");
  const clock = useLedgerClock();
  return (
    <p>
      queued {queued}; expire {caps.expire}; deposits {deposits.length}; ledger {clock.sequence} at {clock.now}
    </p>
  );
}

describe("@rtgs/core/react", () => {
  it("renders the fallback without a session", () => {
    render(<RtgsProvider session={undefined} fallback={<p>connect first</p>}><View /></RtgsProvider>);
    expect(screen.getByText("connect first")).toBeTruthy();
  });

  it("subscribes to the store and releases it on unmount", () => {
    const fake = fakeSession();
    const { unmount } = render(<RtgsProvider session={fake.session}><View /></RtgsProvider>);
    expect(screen.getByText(/queued 2; expire stub; deposits 0; ledger 10 at 1000/)).toBeTruthy();
    act(() =>
      fake.set({
        queuedCount: 3,
        events: [{ ...meta(11), type: "Deposited", bank: "G", amount: 1n }],
        ledger: { sequence: 11, closeTime: 1005 },
      }),
    );
    expect(screen.getByText(/queued 3; expire stub; deposits 1; ledger 11 at 1005/)).toBeTruthy();
    unmount();
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("advances the ledger clock between ledgers", () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSession();
      render(<RtgsProvider session={fake.session}><View /></RtgsProvider>);
      act(() => void vi.advanceTimersByTime(3000));
      expect(screen.getByText(/ledger 10 at 1003/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't jump back when the same ledger is reported again", () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSession();
      render(<RtgsProvider session={fake.session}><View /></RtgsProvider>);
      act(() => void vi.advanceTimersByTime(3000));
      act(() => fake.set({ ledger: { sequence: 10, closeTime: 1000 } }));
      expect(screen.getByText(/ledger 10 at 1003/)).toBeTruthy();
      act(() => fake.set({ ledger: { sequence: 11, closeTime: 1005 } }));
      expect(screen.getByText(/ledger 11 at 1005/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses hooks outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<View />)).toThrow(/RtgsProvider/);
  });
});
