import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderConnected } from "../test/fake.tsx";
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
});
