// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNetworks, withOverrides, type NetworkConfig } from "../src/network/networks.ts";

const sessions: { dispose: ReturnType<typeof vi.fn> }[] = [];
vi.mock("../src/session.ts", () => ({
  connect: vi.fn(async () => {
    const session = { dispose: vi.fn() };
    sessions.push(session);
    return session;
  }),
}));

const { useConnection } = await import("../src/react/index.tsx");
const { connect } = await import("../src/session.ts");

afterEach(() => {
  cleanup();
  sessions.length = 0;
  vi.mocked(connect).mockClear();
});

function Probe(props: { network: NetworkConfig }) {
  const { session } = useConnection(props.network);
  return <p>{session ? "connected" : "connecting"}</p>;
}

describe("useConnection", () => {
  const devnet = loadNetworks({})[0]!;

  it("doesn't reconnect for a new but equal network object", async () => {
    const view = render(<Probe network={withOverrides(devnet, {})} />);
    await waitFor(() => expect(view.getByText("connected")).toBeTruthy());
    view.rerender(<Probe network={withOverrides(devnet, {})} />);
    view.rerender(<Probe network={{ ...devnet }} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("disposes the old session when the network changes", async () => {
    const view = render(<Probe network={devnet} />);
    await waitFor(() => expect(sessions).toHaveLength(1));
    view.rerender(<Probe network={withOverrides(devnet, { rpcUrl: "http://localhost:9999/rpc" })} />);
    await waitFor(() => expect(sessions).toHaveLength(2));
    expect(sessions[0]!.dispose).toHaveBeenCalled();
    view.unmount();
    expect(sessions[1]!.dispose).toHaveBeenCalled();
  });
});
