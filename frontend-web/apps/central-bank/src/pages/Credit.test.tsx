import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BANK_A, NOW, fakeSession, renderConnected, rowOf } from "../test/fake.tsx";
import { NOT_IMPLEMENTED } from "../components/capability.ts";
import { Credit } from "./Credit.tsx";

afterEach(cleanup);

const stubs = { setCollateral: "stub", openRepo: "stub", repay: "stub", convertOverdue: "stub", credit: "stub", repo: "stub" } as const;

describe("Credit", () => {
  it("disables every credit action while the contract's entry points are stubs", () => {
    renderConnected(<Credit />, fakeSession({ capabilities: stubs }));
    expect(screen.getByRole("status").textContent).toMatch(/doesn't implement credit yet/);
    const row = rowOf("Bank A");
    fireEvent.change(within(row).getByLabelText("Collateral for Bank A"), { target: { value: "100" } });
    expect((within(row).getByRole("button", { name: "Set collateral" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getAllByText(NOT_IMPLEMENTED).length).toBeGreaterThan(0);
  });

  it("sets collateral as the central bank once the entry point exists", async () => {
    const { actor } = renderConnected(<Credit />, fakeSession({ capabilities: { ...stubs, setCollateral: "available" } }));
    const row = rowOf("Bank A");
    fireEvent.change(within(row).getByLabelText("Collateral for Bank A"), { target: { value: "0" } });
    fireEvent.click(within(row).getByRole("button", { name: "Set collateral" }));
    await waitFor(() => expect(actor.setCollateral).toHaveBeenCalledWith(BANK_A, 0n));
  });

  it("lists repos with penalty repos highlighted, and converts an overdue one", async () => {
    const fake = fakeSession({
      repos: [
        { id: 0n, bank: BANK_A, amount: 10n, outstanding: 10n, openedAt: NOW - 2000, status: "intraday", rateBps: 0 },
        { id: 1n, bank: BANK_A, amount: 10n, outstanding: 4n, openedAt: NOW - 5000, status: "penalty", rateBps: 500 },
      ],
    });
    const { actor } = renderConnected(<Credit />, fake);
    expect(screen.getByText(/penalty · 500 bps/).closest("tr")?.className).toBe("highlight");
    fireEvent.click(screen.getByRole("button", { name: "Convert to penalty repo" }));
    await waitFor(() => expect(actor.convertOverdue).toHaveBeenCalledWith(0n));
  });
});
