// @vitest-environment jsdom
import { allAvailable, RtgsError, type ConnectOptions, type NetworkConfig, type RtgsSession } from "@rtgs/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { C } from "./events.ts";
import { fakeSession, snapshotOf, u } from "./fake.ts";

// The connection is the only thing that would reach a network: each test decides what it returns.
const connection = vi.hoisted(() => ({
  calls: [] as { network: NetworkConfig | undefined; options: ConnectOptions; key: unknown }[],
  result: {} as { session?: RtgsSession; connecting: boolean; error?: RtgsError; reconnect: () => void },
}));

vi.mock("@rtgs/core/react", async (original) => ({
  ...(await original<typeof import("@rtgs/core/react")>()),
  useConnection: (network: NetworkConfig | undefined, options: ConnectOptions, key: unknown) => {
    connection.calls.push({ network, options, key });
    return network ? connection.result : { connecting: false, reconnect: () => {} };
  },
}));

function open(search: string, env: Record<string, string> = {}) {
  window.history.replaceState(null, "", `/${search}`);
  return render(<App env={env} />);
}

beforeEach(() => {
  connection.calls = [];
  connection.result = { session: fakeSession().session, connecting: false, reconnect: vi.fn() };
});
afterEach(cleanup);

describe("timeline", () => {
  it("groups a deposit with the settlements it released, and names the cascade", () => {
    open("");
    const timeline = screen.getByRole("region", { name: "Timeline" });
    const group = within(timeline).getByText(/deposited/).closest("li.tx-group") as HTMLElement;
    expect(group.textContent).toMatch(/Bank A deposited 300 USD/);
    expect(group.textContent).toMatch(/#0 settled: Bank A → Bank B 300 USD — settled by the eager closure after Bank A's deposit of 300 USD/);
    expect(group.textContent).toMatch(/#1 settled: Bank B → Bank C 200 USD — settled by the eager closure after #0 credited Bank B/);
    // Newest first.
    expect(within(timeline).getAllByRole("listitem").filter((li) => li.classList.contains("tx-group"))[0]).toBe(group);
  });

  it("hides cash token events until asked, and filters by bank", () => {
    open("");
    const timeline = screen.getByRole("region", { name: "Timeline" });
    expect(within(timeline).queryByText(/Cash token transfer/)).toBeNull();
    fireEvent.click(within(timeline).getByLabelText("Cash token"));
    expect(within(timeline).getByText(/Cash token transfer/)).toBeTruthy();

    fireEvent.change(within(timeline).getByLabelText("Bank"), { target: { value: C } });
    const texts = within(timeline)
      .getAllByRole("listitem")
      .filter((li) => li.classList.contains("tx-group"))
      .map((li) => li.textContent);
    expect(texts).toHaveLength(4);
    expect(texts.some((t) => t?.includes("Bank A submitted #0"))).toBe(false);
  });
});

describe("system picture", () => {
  it("shows balances, the central queue and why each queue head waits", () => {
    open("");
    const banks = screen.getByRole("region", { name: "Participants" });
    expect(within(banks).getByText("Bank C").closest("tr")!.textContent).toMatch(/200 USD.*1.*1.*urgent head blocked: needs 800 USD more/);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("2");
    expect(screen.getByRole("region", { name: "Central queue" }).textContent).toMatch(/2 \/ 16 queued/);

    const queues = screen.getByRole("region", { name: "Queues" });
    expect(queues.textContent).toMatch(/uncovered: needs 800 USD more/);
    expect(queues.textContent).toMatch(/held back by the urgent queue/);
    expect(queues.textContent).toMatch(/expires in/);
  });

  it("hides credit while the contract stubs it, and names the stubs", () => {
    open("");
    expect(screen.getByText("Credit (intraday repos) is not implemented in this contract yet.")).toBeTruthy();
    expect(screen.queryByText("Intraday credit")).toBeNull();
    expect(screen.getByText(/Not implemented in this contract yet: expiry, collateral, repos/)).toBeTruthy();
  });

  it("shows credit columns once the contract implements credit", () => {
    const snapshot = snapshotOf(undefined, { capabilities: allAvailable() });
    for (const view of snapshot.banks.values()) (view as { credit?: unknown }).credit = { intraday: u(5), penalty: 0n, collateral: u(50) };
    connection.result = { session: fakeSession(snapshot).session, connecting: false, reconnect: vi.fn() };
    open("");
    expect(screen.getByText("Intraday credit")).toBeTruthy();
    expect(screen.queryByText(/not implemented in this contract yet/)).toBeNull();
  });

  it("shows settled flows between banks, gross and net, and what is queued", () => {
    open("");
    const flows = screen.getByRole("region", { name: "Liquidity flows" });
    const row = (name: string) => within(flows).getAllByText(name)[1]!.closest("tr")!.textContent;
    expect(row("Bank A")).toMatch(/300 USD/);
    fireEvent.click(within(flows).getByRole("radio", { name: "Queued" }));
    expect(row("Bank C")).toMatch(/1000 USD.*10 USD/);
  });
});

describe("payment lifecycle", () => {
  it("follows a payment order from submission to settlement by the eager closure", () => {
    open("?payment=1");
    const drawer = screen.getByRole("dialog", { name: "Payment order 1" });
    expect(drawer.textContent).toMatch(/Submitted/);
    expect(drawer.textContent).toMatch(/Settled \(final\) — settled by the eager closure after #0 credited Bank B/);
    fireEvent.click(within(drawer).getByLabelText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("says where a queued payment order waits", () => {
    open("?payment=3");
    const drawer = screen.getByRole("dialog", { name: "Payment order 3" });
    expect(drawer.textContent).toMatch(/Head of 1 in Bank C's normal queue\. Held back: the sender has urgent payment orders queued/);
  });

  it("reads a payment order the store doesn't hold, and says when none has the id", async () => {
    const fake = fakeSession();
    connection.result = { session: fake.session, connecting: false, reconnect: vi.fn() };
    open("?payment=99");
    expect(await screen.findByText("No payment order has this id.")).toBeTruthy();
    expect(fake.read.payment).toHaveBeenCalledWith(99n);
  });

  it("notes a payment order submitted before the loaded window", async () => {
    const fake = fakeSession();
    fake.read.payment.mockResolvedValue({ id: 7n, from: C, to: "GBANKA", amount: u(1), priority: "normal", submittedAt: 1, status: "settled", settledAt: 2 });
    connection.result = { session: fake.session, connecting: false, reconnect: vi.fn() };
    open("?payment=7");
    expect(await screen.findByText(/Submitted before the loaded window \(which starts at ledger 90\)/)).toBeTruthy();
  });

  it("opens a transaction's events from the timeline", () => {
    open("");
    const timeline = screen.getByRole("region", { name: "Timeline" });
    const group = within(timeline).getByText(/deposited/).closest("li.tx-group") as HTMLElement;
    fireEvent.click(within(group).getByRole("button", { name: /^tx / }));
    const drawer = screen.getByRole("dialog", { name: "Transaction" });
    expect(drawer.textContent).toMatch(/Ledger 103/);
    expect(drawer.textContent).toMatch(/Cash token transfer/);
  });
});

describe("networks", () => {
  it("connects to the default network, devnet, and never to mainnet without the flag", () => {
    open("");
    expect(connection.calls.at(-1)!.network?.id).toBe("devnet");
    expect(screen.queryByRole("option", { name: "Mainnet" })).toBeNull();
  });

  it("refuses a mainnet link when this build doesn't enable mainnet, without falling back", () => {
    open("?network=mainnet");
    expect(screen.getByRole("alert").textContent).toMatch(/Mainnet isn't enabled in this build/);
    expect(connection.calls.every((c) => c.network === undefined)).toBe(true);
  });

  it("asks before watching mainnet, and connects only once confirmed", () => {
    open("?network=mainnet", { VITE_RTGS_ENABLE_MAINNET: "true", VITE_RTGS_MAINNET_RPC_URL: "https://rpc.example" });
    expect(screen.getByRole("alertdialog", { name: "Watch mainnet?" })).toBeTruthy();
    expect(connection.calls.every((c) => c.network === undefined)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Watch mainnet" }));
    expect(connection.calls.at(-1)).toMatchObject({ network: { id: "mainnet" }, options: { acknowledgeMainnet: true } });
  });

  it("goes back to the default network when mainnet is cancelled", () => {
    open("?network=mainnet", { VITE_RTGS_ENABLE_MAINNET: "true", VITE_RTGS_MAINNET_RPC_URL: "https://rpc.example" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(connection.calls.at(-1)!.network?.id).toBe("devnet");
    expect(window.location.search).toBe("?network=devnet");
  });

  it("switching network drops the contract and any open drawer", () => {
    open(`?contract=C${"A".repeat(55)}&payment=1`);
    expect(connection.calls.at(-1)!.options.contractId).toBe(`C${"A".repeat(55)}`);
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "testnet" } });
    expect(window.location.search).toBe("?network=testnet");
    expect(connection.calls.at(-1)).toMatchObject({ network: { id: "testnet" }, options: {} });
    expect(connection.calls.at(-1)!.options.contractId).toBeUndefined();
  });

  it("explains a failed connection on devnet and offers to reconnect", () => {
    const reconnect = vi.fn();
    connection.result = { connecting: false, reconnect, error: new RtgsError("config", "No settlement contract", "Nothing is deployed on this devnet yet.") };
    open("");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/No settlement contract\. Nothing is deployed on this devnet yet\. If the devnet was reset/);
    fireEvent.click(within(alert).getByRole("button", { name: "Reconnect" }));
    expect(reconnect).toHaveBeenCalled();
  });
});

describe("retention window", () => {
  it("states what RPC keeps and where the history starts", () => {
    open("");
    expect(screen.getByText(/RPC keeps ledgers 90–103/).textContent).toMatch(/Older history would need an indexer/);
    expect(screen.getByText(/History loaded from ledger 90/)).toBeTruthy();
  });

  it("reconnects from a chosen ledger, and refuses one outside the window", () => {
    open("");
    fireEvent.change(screen.getByLabelText("Load history from"), { target: { value: "ledger" } });
    const input = screen.getByLabelText("Start ledger");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.getByText(/RPC no longer keeps ledger 50/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(window.location.search).toBe("?from=95");
    expect(connection.calls.at(-1)!.key).toBe("95");
  });

  it("warns when the requested start was older than the window", () => {
    connection.result = { session: fakeSession(snapshotOf(undefined, { feed: { ...snapshotOf().feed, clamped: true } })).session, connecting: false, reconnect: vi.fn() };
    open("?from=1");
    expect(screen.getByText(/requested start was older than the retention window/)).toBeTruthy();
  });

  it("updates live as the store changes", async () => {
    const fake = fakeSession();
    connection.result = { session: fake.session, connecting: false, reconnect: vi.fn() };
    open("");
    act(() => fake.set({ queuedCount: 3 }));
    await waitFor(() => expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("3"));
  });
});
