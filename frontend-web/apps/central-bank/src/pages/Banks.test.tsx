import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BANK_A, CB, CONTRACT, OTHER, fakeSession, renderConnected, rowOf } from "../test/fake.tsx";
import { Banks } from "./Banks.tsx";

afterEach(cleanup);

const contractCard = () => screen.getByRole("heading", { name: "Settlement contract" }).closest(".card") as HTMLElement;

describe("Banks", () => {
  it("freezes the settlement contract only after FREEZE is typed", async () => {
    const { tokenAdmin } = renderConnected(<Banks />);
    fireEvent.click(await within(contractCard()).findByRole("button", { name: /Deauthorize \(freeze\)/ }));
    const dialog = screen.getByRole("dialog", { name: "Freeze the settlement contract?" });
    const confirm = within(dialog).getByRole("button", { name: "Deauthorize the contract" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type FREEZE to confirm"), { target: { value: "freeze" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type FREEZE to confirm"), { target: { value: "FREEZE" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(tokenAdmin.authorize).toHaveBeenCalledWith(CONTRACT, false));
  });

  it("never offers clawback against the settlement contract", () => {
    renderConnected(<Banks />);
    expect(within(contractCard()).queryByRole("button", { name: /Clawback/ })).toBeNull();
  });

  it("claws back from a bank's holding, explaining what clawback can't do", async () => {
    const fake = fakeSession({ holdings: { [BANK_A]: { balance: 50_000_000n } } });
    const { tokenAdmin } = renderConnected(<Banks />, fake);
    const row = rowOf("Bank A");
    const open = within(row).getByRole("button", { name: "Clawback…" });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "Clawback" });
    expect(within(dialog).getByText(/reverse a settled\s+payment/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Clawback amount"), { target: { value: "6" } });
    expect((within(dialog).getByRole("button", { name: "Claw back" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Clawback amount"), { target: { value: "2.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Claw back" }));
    await waitFor(() => expect(tokenAdmin.clawback).toHaveBeenCalledWith(BANK_A, 25_000_000n));
  });

  it("issues cash to an authorized bank", async () => {
    const { tokenAdmin } = renderConnected(<Banks />);
    const row = rowOf("Bank A");
    fireEvent.change(within(row).getByLabelText("Amount for Bank A"), { target: { value: "100" } });
    const issue = within(row).getByRole("button", { name: "Issue" });
    await waitFor(() => expect((issue as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(issue);
    await waitFor(() => expect(tokenAdmin.issue).toHaveBeenCalledWith(BANK_A, 1_000_000_000n));
  });

  it("finishes a write under StrictMode, as in pnpm dev", async () => {
    const { tokenAdmin } = renderConnected(<Banks />, fakeSession(), undefined, { strict: true });
    const row = rowOf("Bank A");
    fireEvent.change(within(row).getByLabelText("Amount for Bank A"), { target: { value: "1" } });
    const issue = within(row).getByRole("button", { name: "Issue" });
    await waitFor(() => expect((issue as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(issue);
    await waitFor(() => expect(tokenAdmin.issue).toHaveBeenCalled());
    expect(await within(row).findByText(/Issue cash to Bank A: done/)).toBeTruthy();
  });

  it("never lists the settlement contract or the central bank as a bank, even if the registry did", () => {
    renderConnected(<Banks />, fakeSession({ extraRegistry: [{ address: CONTRACT, name: "Contract?", sources: ["events"] }, { address: CB, name: "CB?", sources: ["events"] }] }));
    expect(screen.queryByText("Contract?")).toBeNull();
    expect(screen.queryByText("CB?")).toBeNull();
  });

  it("keeps the registration form when registering fails", async () => {
    const fake = fakeSession();
    fake.registry.register.mockRejectedValueOnce(new Error("tx_bad_seq"));
    renderConnected(<Banks />, fake);
    fireEvent.change(screen.getByLabelText("Bank address"), { target: { value: OTHER } });
    fireEvent.change(screen.getByLabelText("Bank name"), { target: { value: "Bank C" } });
    fireEvent.click(screen.getByRole("button", { name: "Register or rename" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByLabelText("Bank address") as HTMLInputElement).value).toBe(OTHER);
    expect((screen.getByLabelText("Bank name") as HTMLInputElement).value).toBe("Bank C");
  });

  it("disables token administration for a signer that isn't the token's admin", async () => {
    renderConnected(<Banks />, fakeSession(), OTHER);
    const row = rowOf("Bank A");
    const button = await within(row).findByRole("button", { name: "Deauthorize" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getAllByText("Only the cash token's admin may do this").length).toBeGreaterThan(0);
  });
});
