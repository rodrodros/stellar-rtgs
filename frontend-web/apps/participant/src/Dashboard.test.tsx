import { RtgsProvider } from "@rtgs/core/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BankBar } from "./connect/BankBar.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { ActingBankProvider } from "./session/ActingBank.tsx";
import { devnetIdentities } from "@rtgs/core";
import { createFakeSession, devnet, USD, type FakeOptions } from "./test/fakeSession.ts";

const BANK_1 = devnetIdentities(devnet(), 1).banks[0]!.address;

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

function setup(options: FakeOptions = {}, bank = "1") {
  const fake = createFakeSession(options);
  render(
    <RtgsProvider session={fake.session}>
      <ActingBankProvider initialBank={bank}>
        <BankBar />
        <Dashboard />
      </ActingBankProvider>
    </RtgsProvider>,
  );
  return fake;
}

const panel = (name: RegExp) => screen.getByRole("region", { name });

async function submit(to: string, amount: string, priority: "Normal" | "Urgent" = "Normal") {
  const form = panel(/new payment order/i);
  fireEvent.change(within(form).getByLabelText("Receiver"), { target: { value: to } });
  fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: amount } });
  fireEvent.click(within(form).getByLabelText(priority));
  fireEvent.click(within(form).getByRole("button", { name: "Submit" }));
}

describe("Dashboard", () => {
  it("shows the custody balance against the cash token holding and the trustline", async () => {
    setup({ balances: { 1: USD(250) } });
    expect(await screen.findByText("250 USD")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("holding").textContent).toBe("10,000 USD"));
    expect(screen.getByText("Authorized")).toBeTruthy();
  });

  it("deposits and then shows the new balance", async () => {
    setup();
    const liquidity = panel(/liquidity/i);
    await within(liquidity).findByText("Authorized");
    fireEvent.change(within(liquidity).getByLabelText(/Amount/), { target: { value: "100" } });
    fireEvent.click(within(liquidity).getByRole("button", { name: "Deposit" }));
    expect(await within(liquidity).findByText("Deposited 100 USD into your settlement balance.")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("settlement-balance").textContent).toBe("100 USD"));
  });

  it("shows core's message when the contract refuses", async () => {
    setup({ balances: { 1: USD(5) } });
    const liquidity = panel(/liquidity/i);
    fireEvent.change(within(liquidity).getByLabelText(/Amount/), { target: { value: "50" } });
    fireEvent.click(within(liquidity).getByRole("button", { name: "Withdraw" }));
    expect((await within(liquidity).findByRole("alert")).textContent).toMatch(/Settlement balance too low/);
  });

  it("says a covered payment order settled at once", async () => {
    const fake = setup({ balances: { 1: USD(100) } });
    await submit(fake.banks[1]!.address, "40");
    expect(await screen.findByText("Payment order #0 settled at once.")).toBeTruthy();
    expect(fake.balance(fake.banks[1]!.address)).toBe(USD(40));
  });

  it("queues an uncovered payment order and explains the blocked head", async () => {
    const fake = setup({ balances: { 1: USD(10) } });
    await submit(fake.banks[1]!.address, "30");
    expect(await screen.findByText("Payment order #0 queued at position 1 in your normal queue.")).toBeTruthy();
    const normal = await screen.findByLabelText("Normal queue");
    await waitFor(() => expect(within(normal).getByText(/Blocked queue head/).textContent).toMatch(/20 USD more is needed/));
    expect(within(normal).getByText(/Expires in 1d/)).toBeTruthy();
  });

  it("reprioritises and revokes a queued payment order", async () => {
    const fake = setup({ balances: { 1: USD(10) } });
    await submit(fake.banks[1]!.address, "30");
    const normal = await screen.findByLabelText("Normal queue");
    fireEvent.click(await within(normal).findByRole("button", { name: "Make urgent" }));
    const urgent = screen.getByLabelText("Urgent queue");
    await waitFor(() => expect(within(urgent).getByText(/#0/)).toBeTruthy());
    expect(within(screen.getByLabelText("Normal queue")).getByText("Empty.")).toBeTruthy();

    fireEvent.click(within(urgent).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(within(screen.getByLabelText("Urgent queue")).getByText("Empty.")).toBeTruthy());
    const row = screen.getByTestId("payment-0");
    expect(within(row).getByText("Revoked")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("shows an incoming settlement live, without a refresh", async () => {
    const fake = setup({ balances: { 2: USD(500) } });
    await waitFor(() => expect(screen.getByTestId("settlement-balance").textContent).toBe("0 USD"));
    await act(() => fake.as(2).submit({ to: fake.banks[0]!.address, amount: USD(75), priority: "urgent" }));
    expect(await screen.findByText("Incoming payment #0 from Bank 2 settled: 75 USD")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("settlement-balance").textContent).toBe("75 USD"));
    const row = screen.getByTestId("payment-0");
    expect(within(row).getByText("From Bank 2")).toBeTruthy();
    expect(within(row).getByText("at once")).toBeTruthy();
  });

  it("settles a queued payment order when a deposit covers it", async () => {
    const fake = setup();
    await submit(fake.banks[1]!.address, "30");
    await screen.findByText(/queued at position 1/);
    await act(() => fake.as(1).deposit(USD(50)));
    await waitFor(() => expect(within(screen.getByTestId("payment-0")).getByText("Settled")).toBeTruthy());
    expect(within(screen.getByLabelText("Normal queue")).getByText("Empty.")).toBeTruthy();
  });

  it("loads payment orders older than the store holds, from the views", async () => {
    const fake = setup({ balances: { 1: USD(100) } });
    for (const amount of [1, 2, 3]) await act(() => fake.as(1).submit({ to: fake.banks[1]!.address, amount: USD(amount), priority: "normal" }));
    await screen.findByTestId("payment-2");
    act(() => fake.forgetBefore(2n));
    await waitFor(() => expect(screen.queryByTestId("payment-0")).toBeNull());
    expect(screen.getByText(/back to #2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load older payment orders" }));
    expect(await screen.findByTestId("payment-0")).toBeTruthy();
    expect(within(screen.getByTestId("payment-1")).getByText("Settled")).toBeTruthy();
    // Everything back to #0 is read: nothing older to load.
    expect(screen.queryByRole("button", { name: "Load older payment orders" })).toBeNull();
  });

  it("degrades the credit section where entry points are stubs", async () => {
    setup({ capabilities: { credit: "stub", repo: "stub", repay: "stub" } });
    expect((await screen.findByTestId("credit-stub")).textContent).toMatch(/Not implemented in this contract version/);
    expect(screen.getByTestId("repos-stub")).toBeTruthy();
  });

  it("lists the bank's repos and repays one", async () => {
    const repo = { id: 3n, bank: BANK_1, amount: USD(60), outstanding: USD(60), openedAt: 1_800_000_000, status: "intraday" as const, rateBps: 0 };
    setup({ balances: { 1: USD(100) }, repos: [repo] });
    const credit = panel(/intraday credit/i);
    expect(await within(credit).findByText("1,000 USD")).toBeTruthy();
    expect(within(credit).getByText(/term ends in 1d/)).toBeTruthy();
    fireEvent.change(within(credit).getByLabelText(/Repay/), { target: { value: "20" } });
    fireEvent.click(within(credit).getByRole("button", { name: "Repay" }));
    expect(await within(credit).findByText("Repaid 20 USD of repo #3.")).toBeTruthy();
    await waitFor(() => expect(within(credit).getByText(/outstanding 40 USD/)).toBeTruthy());
  });

  it("keeps repayment disabled while repay is a stub", async () => {
    setup({ capabilities: { repay: "stub" }, repos: [{ id: 0n, bank: BANK_1, amount: 1n, outstanding: 1n, openedAt: 0, status: "penalty", rateBps: 500 }] });
    const credit = panel(/intraday credit/i);
    expect((within(credit).getByRole("button", { name: "Repay" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(credit).getByText("Penalty 5%")).toBeTruthy();
  });

  it("switches banks with one click and starts afresh", async () => {
    setup({ balances: { 1: USD(1), 2: USD(2) } });
    expect(await screen.findByText("1 USD")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bank 2" }));
    expect(await screen.findByText("2 USD")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bank 2" }).getAttribute("aria-pressed")).toBe("true");
    expect(new URL(window.location.href).searchParams.get("bank")).toBe("2");
  });
});
