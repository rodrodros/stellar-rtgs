// End to end against a running devnet (stellar-implementation's `make devnet-up`):
//   IMPL_NAME=impl-fe-bank IMPL_PORT=8360 make -C ../../../stellar-implementation devnet-up
//   RTGS_DEVNET_RPC=http://localhost:8360/rpc pnpm test:e2e
// Each run bootstraps its own central bank, banks and contract from a fresh seed, then drives
// two copies of the app side by side: one acting as Bank 1, one as Bank 2.
import { bootstrapDevnet, loadNetworks, withOverrides, type Env } from "@rtgs/core";
import { readSettlementWasm } from "@rtgs/core/node";
import { join } from "node:path";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";

// Passed as a path: under jsdom, core's default `new URL(..., import.meta.url)` isn't a file URL
// that Node's fs accepts.
const WASM = join(import.meta.dirname, "../../../packages/core/wasm/settlement.wasm");
const RPC = process.env.RTGS_DEVNET_RPC ?? "http://localhost:8360/rpc";

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    return ((await res.json()) as { result?: { status?: string } }).result?.status === "healthy";
  } catch {
    return false;
  }
}

const up = await healthy();
if (!up) console.warn(`e2e: skipped, no healthy devnet RPC at ${RPC} (set RTGS_DEVNET_RPC, run make devnet-up)`);

/**
 * Waits on the network: ledgers close every few seconds and the feed polls every 2. On timeout
 * the error carries `context`'s text, e.g. the panel showing an error.
 */
const eventually = <T,>(check: () => T, context?: () => HTMLElement) =>
  waitFor(check, {
    timeout: 90_000,
    interval: 250,
    ...(context ? { onTimeout: (e: Error) => new Error(`${e.message.split("\n")[0]}\n${context().textContent}`) } : {}),
  });

describe.skipIf(!up)("participant app on the devnet", () => {
  const seed = `fe-bank-e2e-${Date.now()}`;
  const env: Env = { VITE_RTGS_DEVNET_RPC_URL: RPC, VITE_RTGS_DEVNET_SEED: seed };
  let a: HTMLElement;
  let b: HTMLElement;

  beforeAll(async () => {
    const devnet = { ...withOverrides(loadNetworks({})[0]!, { rpcUrl: RPC }), devnetSeed: seed };
    await bootstrapDevnet({ network: devnet, wasm: await readSettlementWasm(WASM), banks: 2 });
    a = render(<App env={env} bank="1" />).container;
    b = render(<App env={env} bank="2" />).container;
  });

  afterAll(cleanup);

  const region = (root: HTMLElement, name: RegExp) => within(root).getByRole("region", { name });
  const balanceOf = (root: HTMLElement) => within(root).getByTestId("settlement-balance").textContent;

  async function submit(root: HTMLElement, to: string, amount: string) {
    const form = region(root, /new payment order/i);
    fireEvent.change(within(form).getByLabelText("Receiver"), { target: { value: to } });
    fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: amount } });
    fireEvent.click(within(form).getByRole("button", { name: "Submit" }));
  }

  /** `shown`: the amount as the app prints it, e.g. "1,000". */
  async function deposit(root: HTMLElement, amount: string, shown: string) {
    const liquidity = region(root, /liquidity/i);
    fireEvent.change(within(liquidity).getByLabelText(/Amount/), { target: { value: amount } });
    fireEvent.click(within(liquidity).getByRole("button", { name: "Deposit" }));
    await eventually(() => within(liquidity).getByText(`Deposited ${shown} USD into your settlement balance.`), () => liquidity);
  }

  const bank2 = () => {
    const option = within(region(a, /new payment order/i)).getByRole("option", { name: "Bank 2" }) as HTMLOptionElement;
    return option.value;
  };

  it("connects both banks to the fresh deployment", async () => {
    await eventually(() => expect(within(region(a, /liquidity/i)).getByText("Authorized")).toBeTruthy());
    await eventually(() => expect(within(region(b, /liquidity/i)).getByText("Authorized")).toBeTruthy());
    await eventually(() => expect(balanceOf(a)).toBe("0 USD"));
    expect(within(a).getByTestId("holding").textContent).toBe("10,000 USD");
  });

  it("deposits, then settles a covered payment order at once", async () => {
    await deposit(a, "1000", "1,000");
    await eventually(() => expect(balanceOf(a)).toBe("1,000 USD"));
    await submit(a, bank2(), "100");
    await eventually(() => within(a).getByText("Payment order #0 settled at once."), () => region(a, /new payment order/i));
    await eventually(() => expect(balanceOf(b)).toBe("100 USD"));
  });

  it("queues an uncovered payment order behind a blocked head, then reprioritises and revokes it", async () => {
    await submit(a, bank2(), "5000");
    await eventually(() => within(a).getByText("Payment order #1 queued at position 1 in your normal queue."), () => region(a, /new payment order/i));
    const normal = () => within(a).getByLabelText("Normal queue");
    await eventually(() => expect(within(normal()).getByText(/Blocked queue head/).textContent).toMatch(/4,100 USD more is needed/));

    fireEvent.click(within(normal()).getByRole("button", { name: "Make urgent" }));
    const urgent = () => within(a).getByLabelText("Urgent queue");
    await eventually(() => within(urgent()).getByText("#1"));
    fireEvent.click(within(urgent()).getByRole("button", { name: "Revoke" }));
    await eventually(() => within(urgent()).getByText("Empty."));
    await eventually(() => within(within(a).getByTestId("payment-1")).getByText("Revoked"));
  });

  it("settles a queued payment order when a deposit covers it, and the receiver sees it live", async () => {
    await submit(a, bank2(), "2000");
    await eventually(() => within(a).getByText(/Payment order #2 queued/));
    await deposit(a, "1500", "1,500");
    await eventually(() => within(within(a).getByTestId("payment-2")).getByText("Settled"));
    await eventually(() => within(b).getByText("Incoming payment #2 from Bank 1 settled: 2,000 USD"));
    await eventually(() => expect(balanceOf(b)).toBe("2,100 USD"));
    expect(within(within(b).getByTestId("payment-2")).getByText(/released by Bank 1's deposit/)).toBeTruthy();
  });

  it("reconnects after saving deployment settings, keeping the app alive", async () => {
    fireEvent.click(within(a).getByText(/Deployment settings/));
    fireEvent.click(within(a).getByRole("button", { name: "Save and reconnect" }));
    await eventually(() => expect(within(a).getByRole("button", { name: "Bank 1", pressed: true })).toBeTruthy());
    await eventually(() => expect(balanceOf(a)).toBe("400 USD"));
    expect(within(a).queryByText(/Session closed/)).toBeNull();
  });
});
