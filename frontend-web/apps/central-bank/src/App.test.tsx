import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { BANK_A, BANK_B, CONFIG, NOW, OTHER, fakeSession, payment, renderConnected, signer } from "./test/fake.tsx";

afterEach(cleanup);
beforeEach(() => {
  location.hash = "";
});

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

describe("the auto-keeper", () => {
  const due = [payment(1n, BANK_A, BANK_B, 10n, { submittedAt: NOW - CONFIG.expirySecs - 1 })];
  const tab = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
  // Tabs follow the location hash, whose change event jsdom fires asynchronously.
  const checkbox = () => screen.findByRole("checkbox") as Promise<HTMLInputElement>;

  it("keeps running when another page is shown", async () => {
    renderConnected(<App />, fakeSession({ payments: due }));
    tab("Keeper");
    fireEvent.click(await checkbox());
    tab("Overview");
    await screen.findByRole("heading", { name: "System overview" });
    tab("Keeper");
    expect((await checkbox()).checked).toBe(true);
  });

  it("turns off when the signer changes", async () => {
    const fake = fakeSession({ payments: due });
    const { rerender } = renderConnected(<App />, fake);
    tab("Keeper");
    fireEvent.click(await checkbox());
    await waitFor(() => expect(fake.actor.expire).toHaveBeenCalled());
    // The same tree, now with another signer: renderConnected's provider takes `app` overrides.
    rerender(renderConnected.tree(<App />, fake, OTHER, { app: { signer: signer(OTHER) } }));
    await waitFor(async () => expect((await checkbox()).checked).toBe(false));
  });
});
