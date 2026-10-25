import { describe, expect, it } from "vitest";
import {
  defaultNetwork,
  ledgerUrl,
  txUrl,
  loadNetworks,
  overridesStore,
  parseBanks,
  PASSPHRASES,
  withOverrides,
} from "../src/network/networks.ts";
import { A, B } from "./helpers.ts";

describe("network registry", () => {
  it("offers devnet and testnet by default, never mainnet", () => {
    const nets = loadNetworks({});
    expect(nets.map((n) => n.id)).toEqual(["devnet", "testnet"]);
    const devnet = nets[0]!;
    expect(devnet.rpcUrl).toBe("http://localhost:8300/rpc");
    expect(devnet.passphrase).toBe(PASSPHRASES.devnet);
    expect(devnet.friendbotUrl).toBe("http://localhost:8300/friendbot");
    expect(devnet.allowHttp).toBe(true);
    expect(nets[1]!.allowHttp).toBe(false);
    expect(defaultNetwork(nets).id).toBe("devnet");
  });

  it("derives the devnet friendbot from a remapped RPC port (C-HB-073)", () => {
    const [devnet] = loadNetworks({ VITE_RTGS_DEVNET_RPC_URL: "http://localhost:8350/rpc" });
    expect(devnet!.friendbotUrl).toBe("http://localhost:8350/friendbot");
  });

  it("lists mainnet only behind the build flag, with no default RPC", () => {
    const nets = loadNetworks({ VITE_RTGS_ENABLE_MAINNET: "true" });
    const mainnet = nets.find((n) => n.id === "mainnet")!;
    expect(mainnet.passphrase).toBe(PASSPHRASES.mainnet);
    expect(mainnet.rpcUrl).toBe("");
    expect(mainnet.friendbotUrl).toBeUndefined();
    expect(loadNetworks({ VITE_RTGS_ENABLE_MAINNET: "1" }).some((n) => n.id === "mainnet")).toBe(false);
  });

  it("never defaults to mainnet", () => {
    const env = { VITE_RTGS_ENABLE_MAINNET: "true", VITE_RTGS_DEFAULT_NETWORK: "mainnet" };
    expect(defaultNetwork(loadNetworks(env), env).id).toBe("devnet");
    const env2 = { VITE_RTGS_DEFAULT_NETWORK: "testnet" };
    expect(defaultNetwork(loadNetworks(env2), env2).id).toBe("testnet");
  });

  it("reads contract ids, the central bank and banks from env, VITE_ or plain RTGS_", () => {
    const nets = loadNetworks({
      VITE_RTGS_TESTNET_CONTRACT_ID: "CTEST",
      RTGS_TESTNET_CENTRAL_BANK: A,
      VITE_RTGS_TESTNET_BANKS: `${A}:Bank A, ${B}`,
    });
    const testnet = nets.find((n) => n.id === "testnet")!;
    expect(testnet.contractId).toBe("CTEST");
    expect(testnet.centralBank).toBe(A);
    expect(testnet.banks).toEqual([{ address: A, name: "Bank A" }, { address: B }]);
  });

  it("parses a JSON bank list and rejects a malformed one", () => {
    expect(parseBanks(JSON.stringify([{ address: A, name: "X" }]))).toEqual([{ address: A, name: "X" }]);
    expect(() => parseBanks('[{"name":"no address"}]')).toThrow(/bank list/);
  });

  it("links transactions and ledgers to an explorer, except on the devnet", () => {
    const nets = loadNetworks({ VITE_RTGS_ENABLE_MAINNET: "true", VITE_RTGS_MAINNET_RPC_URL: "https://rpc.example" });
    const [devnet, testnet, mainnet] = nets;
    expect(txUrl(devnet!, "ab")).toBeUndefined();
    expect(txUrl(testnet!, "ab")).toBe("https://stellar.expert/explorer/testnet/tx/ab");
    expect(ledgerUrl(mainnet!, 7)).toBe("https://stellar.expert/explorer/public/ledger/7");
    const custom = loadNetworks({
      VITE_RTGS_DEVNET_EXPLORER_TX_URL: "http://localhost:9000/tx/{hash}",
      VITE_RTGS_DEVNET_EXPLORER_LEDGER_URL: "http://localhost:9000/l/{ledger}",
    })[0]!;
    expect(txUrl(custom, "cd")).toBe("http://localhost:9000/tx/cd");
    expect(ledgerUrl(withOverrides(custom, { contractId: "C" }), 3)).toBe("http://localhost:9000/l/3");
  });

  it("applies runtime overrides; an empty string clears a field", () => {
    const [devnet] = loadNetworks({ VITE_RTGS_DEVNET_CONTRACT_ID: "COLD" });
    const next = withOverrides(devnet!, { rpcUrl: "http://127.0.0.1:9000/rpc", contractId: "" });
    expect(next.rpcUrl).toBe("http://127.0.0.1:9000/rpc");
    expect(next.friendbotUrl).toBe("http://127.0.0.1:9000/friendbot");
    expect(next.contractId).toBeUndefined();
    expect(devnet!.contractId).toBe("COLD");
  });

  it("persists overrides per app and network, and survives a throwing storage", () => {
    const data = new Map<string, string>();
    const store = overridesStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }, "observer");
    store.save("testnet", { contractId: "C1" });
    expect(store.load("testnet")).toEqual({ contractId: "C1" });
    expect(store.load("devnet")).toEqual({});
    const broken = overridesStore(
      {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
      "x",
    );
    expect(broken.load("devnet")).toEqual({});
    expect(() => broken.save("devnet", {})).not.toThrow();
  });
});
