import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { OTHER, renderConnected } from "./test/fake.tsx";

afterEach(cleanup);

// renderConnected wraps in a fixed app session; App renders its own RtgsProvider from it.
describe("App", () => {
  it("is read-only for a signer that isn't the contract's central bank", () => {
    renderConnected(<App />, undefined, OTHER);
    expect(screen.getByText(/not this contract's central bank/)).toBeTruthy();
  });

  it("is read-only without a signer", () => {
    renderConnected(<App />, undefined, null);
    expect(screen.getByText(/No signer connected/)).toBeTruthy();
  });

  it("opens on the overview for the central bank, with no read-only notice", () => {
    renderConnected(<App />);
    expect(screen.getByRole("heading", { name: "System overview" })).toBeTruthy();
    expect(screen.queryByText(/actions are disabled/)).toBeNull();
  });
});
