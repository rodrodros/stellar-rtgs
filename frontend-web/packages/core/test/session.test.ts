import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNetworks } from "../src/network/networks.ts";
import { connect } from "../src/session.ts";
import { CONTRACT } from "./helpers.ts";

const [devnet] = loadNetworks({});

afterEach(() => vi.restoreAllMocks());

describe("connect", () => {
  it("says nothing is deployed only when RPC reports the contract missing", async () => {
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({ passphrase: devnet!.passphrase, protocolVersion: "29" });
    const instance = vi.spyOn(rpc.Server.prototype, "getContractInstance");
    instance.mockRejectedValueOnce({ code: 404, message: "not found" });
    await expect(connect(devnet!, { contractId: CONTRACT })).rejects.toMatchObject({ kind: "config", title: "No settlement contract" });
    instance.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(connect(devnet!, { contractId: CONTRACT })).rejects.toMatchObject({ kind: "rpc", title: "Network unreachable" });
  });
});
