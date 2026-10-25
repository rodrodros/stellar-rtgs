import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadNetworks, PASSPHRASES, type Env } from "@rtgs/core";
import { NetworkBar } from "../components/NetworkBar.tsx";
import { AppSessionProvider, signerFor, useAppSession } from "./AppSession.tsx";

// No network in these tests: the connection is a spy.
const useConnection = vi.hoisted(() => vi.fn(() => ({ connecting: false, reconnect: () => {} })));
vi.mock("@rtgs/core/react", async (original) => ({ ...(await original<object>()), useConnection }));

beforeEach(() => {
  useConnection.mockClear();
  localStorage.clear();
});
afterEach(cleanup);

const MAINNET: Env = { VITE_RTGS_ENABLE_MAINNET: "true", VITE_RTGS_MAINNET_RPC_URL: "https://mainnet.example/rpc" };

function SignerProbe() {
  const { signer, network } = useAppSession();
  return <p>signer on {network.id}: {signer ? signer.label ?? signer.address : "none"}</p>;
}

function renderBar(env: Env = {}) {
  return render(
    <AppSessionProvider env={env}>
      <NetworkBar />
      <SignerProbe />
    </AppSessionProvider>,
  );
}

const lastConnection = () => useConnection.mock.calls.at(-1) as unknown as [{ id: string }, { acknowledgeMainnet?: true }];

describe("network switching", () => {
  it("doesn't offer mainnet unless the build enables it", () => {
    renderBar();
    const options = within(screen.getByLabelText("Network")).getAllByRole("option").map((o) => o.getAttribute("value"));
    expect(options).toEqual(["devnet", "testnet"]);
  });

  it("starts on devnet even when the build asks for mainnet first", () => {
    renderBar({ ...MAINNET, VITE_RTGS_DEFAULT_NETWORK: "mainnet" });
    expect((screen.getByLabelText("Network") as HTMLSelectElement).value).toBe("devnet");
    expect(lastConnection()[0].id).toBe("devnet");
  });

  it("selects mainnet only after the typed confirmation, and connects with the acknowledgement", () => {
    renderBar(MAINNET);
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "mainnet" } });
    const dialog = screen.getByRole("dialog", { name: "Switch to mainnet?" });
    expect(lastConnection()[0].id).toBe("devnet");
    const confirm = within(dialog).getByRole("button", { name: "Use mainnet" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type mainnet to confirm"), { target: { value: "mainnet" } });
    fireEvent.click(confirm);
    expect(lastConnection()[0].id).toBe("mainnet");
    expect(lastConnection()[1].acknowledgeMainnet).toBe(true);
    expect(screen.getByText(/MAINNET: real funds/)).toBeTruthy();
  });

  it("cancelling the confirmation stays on the current network", () => {
    renderBar(MAINNET);
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "mainnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Network") as HTMLSelectElement).value).toBe("devnet");
  });

  it("drops the signer when the network changes", () => {
    renderBar();
    expect(screen.getByText("signer on devnet: Central bank")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "testnet" } });
    expect(screen.getByText("signer on testnet: none")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
  });
});

describe("signerFor", () => {
  it("keeps a signer only on the network it signs for", () => {
    const [devnet, testnet] = loadNetworks({});
    const signer = { kind: "devnet-keypair" as const, address: "G", networkPassphrase: PASSPHRASES.devnet, signTransaction: async (x: string) => x };
    expect(signerFor(signer, devnet!)).toBe(signer);
    expect(signerFor(signer, testnet!)).toBeUndefined();
  });
});
