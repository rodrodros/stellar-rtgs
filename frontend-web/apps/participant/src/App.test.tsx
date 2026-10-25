import type { ConnectOptions, NetworkConfig } from "@rtgs/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSession } from "./test/fakeSession.ts";

// The real `useConnection` and `RtgsProvider`, over a `connect` that hands out fake sessions.
// They close on dispose like core's, so a subtree that touches a closed session fails here too.
const connected: { network: NetworkConfig; options: ConnectOptions; fake: ReturnType<typeof createFakeSession> }[] = [];
vi.mock("../../../packages/core/src/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/core/src/session.ts")>()),
  connect: async (network: NetworkConfig, options: ConnectOptions = {}) => {
    const fake = createFakeSession({ network });
    connected.push({ network, options, fake });
    return fake.session;
  },
}));

const { App } = await import("./App.tsx");

const ENV = { VITE_RTGS_ENABLE_MAINNET: "true", VITE_RTGS_MAINNET_RPC_URL: "https://mainnet.example" };

beforeEach(() => {
  connected.length = 0;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

const select = () => screen.getByLabelText("Network") as HTMLSelectElement;
const noFailure = () => expect(screen.queryByText(/Session closed|Signer is for another network/)).toBeNull();

describe("App", () => {
  it("starts on the devnet, never mainnet", async () => {
    render(<App env={{ ...ENV, VITE_RTGS_DEFAULT_NETWORK: "mainnet" }} />);
    expect(select().value).toBe("devnet");
    expect(await screen.findByText("Choose a bank to act as.")).toBeTruthy();
    expect(connected.map((c) => c.network.id)).toEqual(["devnet"]);
  });

  it("lists mainnet only when the build enables it", () => {
    render(<App env={{}} />);
    expect([...select().options].map((o) => o.value)).toEqual(["devnet", "testnet"]);
  });

  it("asks before mainnet and connects only once confirmed", async () => {
    render(<App env={ENV} />);
    await screen.findByText("Choose a bank to act as.");
    fireEvent.change(select(), { target: { value: "mainnet" } });
    const confirm = screen.getByRole("button", { name: "Use mainnet" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(select().value).toBe("devnet");

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "mainnet" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(select().value).toBe("mainnet");
    expect(screen.getByRole("alert").textContent).toMatch(/Mainnet: every action moves real funds/);
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(connected.at(-1)).toMatchObject({ network: { id: "mainnet" }, options: { acknowledgeMainnet: true } });
    noFailure();
  });

  it("cancelling the mainnet dialog stays where it was", async () => {
    render(<App env={ENV} />);
    await screen.findByText("Choose a bank to act as.");
    fireEvent.change(select(), { target: { value: "mainnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(select().value).toBe("devnet");
    expect(connected.some((c) => c.network.id === "mainnet")).toBe(false);
  });

  it("switches networks without touching the closed session, and drops the acting bank", async () => {
    render(<App env={ENV} />);
    fireEvent.click(await screen.findByRole("button", { name: "Bank 1" }));
    expect(await screen.findByText("Liquidity")).toBeTruthy();

    fireEvent.change(select(), { target: { value: "testnet" } });
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeTruthy();
    noFailure();
    expect(connected[0]!.fake.disposed()).toBe(true);

    // Back on the devnet, the tab's remembered bank comes back, as a signer for the new session.
    fireEvent.change(select(), { target: { value: "devnet" } });
    expect(await screen.findByRole("button", { name: "Bank 1", pressed: true })).toBeTruthy();
    expect(await screen.findByText("Liquidity")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Bank 1" })).toHaveLength(1);
    noFailure();
  });

  it("applies deployment overrides and reconnects without failing", async () => {
    render(<App env={ENV} />);
    fireEvent.click(await screen.findByRole("button", { name: "Bank 1" }));
    await screen.findByText("Liquidity");
    fireEvent.click(screen.getByText(/Deployment settings/));
    fireEvent.change(screen.getByLabelText("Settlement contract id"), { target: { value: "CNEWCONTRACT" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save and reconnect" })));
    expect(connected.at(-1)?.network.contractId).toBe("CNEWCONTRACT");
    expect(connected[0]!.fake.disposed()).toBe(true);
    expect(await screen.findByText("Liquidity")).toBeTruthy();
    noFailure();
  });
});
