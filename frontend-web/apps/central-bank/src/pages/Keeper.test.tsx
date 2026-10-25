import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BANK_A, BANK_B, CONFIG, NOW, fakeSession, payment, renderConnected } from "../test/fake.tsx";
import { Keeper } from "./Keeper.tsx";

afterEach(cleanup);

describe("Keeper", () => {
  const payments = [
    payment(1n, BANK_A, BANK_B, 10n, { submittedAt: NOW - CONFIG.expirySecs - 1 }), // past expiry
    payment(2n, BANK_A, BANK_B, 10n, { submittedAt: NOW - CONFIG.expirySecs }), // exactly at it: not yet
    payment(3n, BANK_A, BANK_B, 10n, { submittedAt: NOW - 500, status: "settled" }),
  ];

  it("lists only queued payment orders strictly past their expiry, and expires them", async () => {
    const { actor } = renderConnected(<Keeper />, fakeSession({ payments }));
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.queryByText("#2")).toBeNull();
    expect(screen.queryByText("#3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expire" }));
    await waitFor(() => expect(actor.expire).toHaveBeenCalledWith(1n));
  });

  it("disables expiry while the entry point is a stub", () => {
    renderConnected(<Keeper />, fakeSession({ payments, capabilities: { expire: "stub" } }));
    expect((screen.getByRole("button", { name: "Expire" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs the auto-keeper only once switched on", async () => {
    const { actor } = renderConnected(<Keeper />, fakeSession({ payments }));
    expect(actor.expire).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(actor.expire).toHaveBeenCalledWith(1n));
    expect(actor.expire).toHaveBeenCalledTimes(1);
  });
});
