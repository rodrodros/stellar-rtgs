import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderConnected } from "../test/fake.tsx";

// No network: the bootstrap and the Wasm are spies.
const bootstrapDevnet = vi.hoisted(() => vi.fn());
vi.mock("@rtgs/core", async (original) => ({
  ...(await original<object>()),
  bootstrapDevnet,
  loadSettlementWasm: async () => new Uint8Array(),
}));
import { Setup } from "./Setup.tsx";

afterEach(cleanup);

describe("Setup", () => {
  it("won't bootstrap with an invalid Config, and says which field", () => {
    renderConnected(<Setup />);
    const bootstrap = screen.getByRole("button", { name: "Bootstrap" }) as HTMLButtonElement;
    expect(bootstrap.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("queueCap"), { target: { value: "" } });
    expect(bootstrap.disabled).toBe(true);
    expect(screen.getByText(/whole numbers needed for queueCap/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("queueCap"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Banks"), { target: { value: "1.5" } });
    expect(bootstrap.disabled).toBe(true);
  });

  it("clears a saved contract id after a bootstrap, so the app reconnects to the published contract", async () => {
    bootstrapDevnet.mockResolvedValueOnce({
      contractId: "CNEW",
      sacId: "CSAC",
      cashToken: { code: "USD", issuer: "GCB" },
      centralBank: "GCB",
      banks: [],
    });
    const saveOverrides = vi.fn();
    const reconnect = vi.fn();
    const setNotice = vi.fn();
    renderConnected(<Setup />, undefined, undefined, {
      app: { overrides: { contractId: "CSTALE", rpcUrl: "http://localhost:8390/rpc" }, saveOverrides, reconnect, setNotice },
    });
    fireEvent.click(screen.getByRole("button", { name: "Bootstrap" }));
    await waitFor(() => expect(reconnect).toHaveBeenCalled());
    expect(saveOverrides).toHaveBeenCalledWith({ rpcUrl: "http://localhost:8390/rpc" });
    expect(setNotice).toHaveBeenCalledWith(expect.stringMatching(/settlement contract CNEW/));
  });
});
