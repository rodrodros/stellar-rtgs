import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BANK_A, BANK_B, bankView, fakeSession, payment, renderConnected, rowOf } from "../test/fake.tsx";
import { Overview } from "./Overview.tsx";

afterEach(cleanup);

describe("Overview", () => {
  it("shows each queue head first, urgent before normal, and why a head is blocked", () => {
    const urgent = [payment(4n, BANK_A, BANK_B, 900n, { priority: "urgent" })];
    const normal = [payment(2n, BANK_A, BANK_B, 10n), payment(5n, BANK_A, BANK_B, 20n)];
    renderConnected(<Overview />, fakeSession({ banks: [bankView(BANK_A, "Bank A", 500n, { urgent, normal }), bankView(BANK_B, "Bank B", 0n)] }));
    const row = rowOf("Bank A");
    const queues = within(row).getAllByRole("listitem").map((li) => li.textContent);
    expect(queues[0]).toMatch(/^#4/);
    expect(queues[1]).toMatch(/^#2.*head/);
    expect(queues[2]).toMatch(/^#5/);
    expect(within(row).getByLabelText("urgent queue").textContent).toMatch(/blocked: head not covered/);
    expect(within(row).getByLabelText("normal queue").textContent).toMatch(/blocked: waits for the bank's urgent queue/);
  });

  it("shows the central queue against its cap", () => {
    renderConnected(<Overview />, fakeSession({ snapshot: { queuedCount: 16 } }));
    expect(screen.getByLabelText("Central queue").textContent).toMatch(/16 \/ 16.*full/);
  });

  it("flags a broken conservation check", async () => {
    // The contract holds 100 less than the banks' recorded 600: a direct clawback (H1).
    renderConnected(<Overview />, fakeSession({ contractHolding: { balance: 500n } }));
    // A mismatch is read twice before it is reported.
    const alert = await within(screen.getByLabelText("Conservation")).findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toMatch(/broken by/);
  });

  it("doesn't alarm on a mismatch that a second read doesn't confirm (a deposit between the reads)", async () => {
    const fake = fakeSession();
    // The first read straddles a deposit: the holding already includes it, the balance doesn't.
    vi.mocked(fake.session.token.holding).mockImplementationOnce(async () => ({
      balance: 601n,
      exists: true,
      authorized: true,
      authorizedToMaintainLiabilities: false,
      clawbackEnabled: true,
    }));
    renderConnected(<Overview />, fake);
    expect(await within(screen.getByLabelText("Conservation")).findByText("holds", {}, { timeout: 5000 })).toBeTruthy();
    expect(within(screen.getByLabelText("Conservation")).queryByRole("alert")).toBeNull();
  });

  it("says conservation holds when it does", async () => {
    renderConnected(<Overview />);
    expect(await within(screen.getByLabelText("Conservation")).findByText("holds")).toBeTruthy();
  });
});
