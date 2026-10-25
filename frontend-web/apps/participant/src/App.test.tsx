import type { ConnectOptions, NetworkConfig, RtgsSession } from "@rtgs/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSession } from "./test/fakeSession.ts";

// The real hook would reach RPC; this one hands out a fake session per network and records
// what the app asked for.
const calls: { network?: NetworkConfig; options: ConnectOptions }[] = [];
const sessions = new Map<string, RtgsSession>();
vi.mock("@rtgs/core/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rtgs/core/react")>()),
  useConnection: (network: NetworkConfig | undefined, options: ConnectOptions = {}) => {
    calls.push({ ...(network ? { network } : {}), options });
    if (!network) return { connecting: false, reconnect: () => {} };
    if (!sessions.has(network.id)) sessions.set(network.id, createFakeSession({ network }).session);
    return { session: sessions.get(network.id), connecting: false, reconnect: () => {} };
  },
}));

const { App } = await import("./App.tsx");

const ENV = { VITE_RTGS_ENABLE_MAINNET: "true", VITE_RTGS_MAINNET_RPC_URL: "https://mainnet.example" };

beforeEach(() => {
  calls.length = 0;
  sessions.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

const select = () => screen.getByLabelText("Network") as HTMLSelectElement;

describe("App", () => {
  it("starts on the devnet, never mainnet", () => {
    render(<App env={{ ...ENV, VITE_RTGS_DEFAULT_NETWORK: "mainnet" }} />);
    expect(select().value).toBe("devnet");
    expect(screen.getByText("Choose a bank to act as.")).toBeTruthy();
  });

  it("lists mainnet only when the build enables it", () => {
    render(<App env={{}} />);
    expect([...select().options].map((o) => o.value)).toEqual(["devnet", "testnet"]);
  });

  it("asks before mainnet and connects only once confirmed", () => {
    render(<App env={ENV} />);
    fireEvent.change(select(), { target: { value: "mainnet" } });
    const confirm = screen.getByRole("button", { name: "Use mainnet" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(select().value).toBe("devnet");

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "mainnet" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(select().value).toBe("mainnet");
    expect(screen.getByRole("alert").textContent).toMatch(/Mainnet: every action moves real funds/);
    expect(calls.at(-1)).toMatchObject({ network: { id: "mainnet" }, options: { acknowledgeMainnet: true } });
  });

  it("cancelling the mainnet dialog stays where it was", () => {
    render(<App env={ENV} />);
    fireEvent.change(select(), { target: { value: "mainnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(select().value).toBe("devnet");
    expect(calls.some((c) => c.network?.id === "mainnet")).toBe(false);
  });

  it("drops the acting bank when the network changes", async () => {
    render(<App env={ENV} />);
    fireEvent.click(await screen.findByRole("button", { name: "Bank 1" }));
    expect(await screen.findByRole("button", { name: "Bank 1", pressed: true })).toBeTruthy();
    fireEvent.change(select(), { target: { value: "testnet" } });
    expect(await screen.findByText("Connect the wallet of a participant's account.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    // Back on the devnet, the tab's remembered bank comes back, but as a new signer.
    fireEvent.change(select(), { target: { value: "devnet" } });
    expect(await screen.findByRole("button", { name: "Bank 1", pressed: true })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Bank 1" })).toHaveLength(1);
  });

  it("applies deployment overrides and reconnects", () => {
    render(<App env={ENV} />);
    fireEvent.click(screen.getByText(/Deployment settings/));
    fireEvent.change(screen.getByLabelText("Settlement contract id"), { target: { value: "CNEWCONTRACT" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and reconnect" }));
    expect(calls.at(-1)?.network?.contractId).toBe("CNEWCONTRACT");
  });
});
