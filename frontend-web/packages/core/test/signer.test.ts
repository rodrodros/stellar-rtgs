import { Keypair, Networks, TransactionBuilder, Account, Operation, BASE_FEE } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { RtgsError } from "../src/errors.ts";
import { loadNetworks, PASSPHRASES } from "../src/network/networks.ts";
import { deriveDevnetKeypair, devnetIdentities, keypairSigner } from "../src/signer/keypair.ts";
import { connectWallet, walletSigner, type WalletKit } from "../src/signer/wallet.ts";
import { A } from "./helpers.ts";

const [devnet, testnet] = loadNetworks({});

function tx(passphrase: string, source = A): string {
  return new TransactionBuilder(new Account(source, "1"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build()
    .toXDR();
}

describe("devnet keypair signer", () => {
  it("derives the same identities from the same seed, different ones from another", () => {
    const a = devnetIdentities(devnet!, 3);
    const b = devnetIdentities(devnet!, 3);
    expect(a.centralBank.address).toBe(b.centralBank.address);
    expect(a.banks.map((s) => s.address)).toEqual(b.banks.map((s) => s.address));
    expect(new Set([a.centralBank.address, ...a.banks.map((s) => s.address)]).size).toBe(4);
    expect(a.banks[1]!.label).toBe("Owl Street");
    const other = devnetIdentities({ ...devnet!, devnetSeed: "another" }, 1);
    expect(other.centralBank.address).not.toBe(a.centralBank.address);
    expect(deriveDevnetKeypair("rtgs-devnet-demo", "central-bank").publicKey()).toBe(a.centralBank.address);
  });

  it("refuses to exist for testnet or mainnet", () => {
    expect(() => devnetIdentities(testnet!)).toThrow(RtgsError);
    expect(() => keypairSigner(Keypair.random(), { passphrase: PASSPHRASES.mainnet })).toThrow(/devnet/);
  });

  it("keeps its network check when a method is passed around on its own", async () => {
    const { signTransaction } = keypairSigner(Keypair.random(), devnet!);
    await expect(signTransaction(tx(Networks.TESTNET), { networkPassphrase: Networks.TESTNET })).rejects.toMatchObject({
      kind: "network-mismatch",
    });
  });

  it("signs devnet transactions and refuses another passphrase", async () => {
    const kp = Keypair.random();
    const signer = keypairSigner(kp, devnet!);
    const signed = TransactionBuilder.fromXDR(
      await signer.signTransaction(tx(PASSPHRASES.devnet, kp.publicKey()), { networkPassphrase: PASSPHRASES.devnet }),
      PASSPHRASES.devnet,
    );
    expect(signed.signatures).toHaveLength(1);
    await expect(signer.signTransaction(tx(Networks.TESTNET), { networkPassphrase: Networks.TESTNET })).rejects.toMatchObject({
      kind: "network-mismatch",
    });
  });
});

function fakeKit(network = PASSPHRASES.testnet): WalletKit & { signTransaction: ReturnType<typeof vi.fn> } {
  return {
    authModal: vi.fn(async () => ({ address: A })),
    signTransaction: vi.fn(async (xdr: string) => ({ signedTxXdr: `${xdr}+signed` })),
    signAuthEntry: vi.fn(async (e: string) => ({ signedAuthEntry: e })),
    getNetwork: vi.fn(async () => ({ networkPassphrase: network })),
    disconnect: vi.fn(async () => {}),
  };
}

describe("wallet signer", () => {
  it("connects through the kit and signs with the session's passphrase", async () => {
    const kit = fakeKit();
    const signer = await connectWallet(testnet!, kit);
    expect(signer).toMatchObject({ kind: "wallet", address: A, networkPassphrase: PASSPHRASES.testnet });
    expect(await signer.signTransaction("XDR", { networkPassphrase: PASSPHRASES.testnet })).toBe("XDR+signed");
    expect(kit.signTransaction).toHaveBeenCalledWith("XDR", { networkPassphrase: PASSPHRASES.testnet, address: A });
  });

  it("refuses a sign request for another network", async () => {
    const signer = walletSigner(fakeKit(), A, testnet!);
    await expect(signer.signTransaction("XDR", { networkPassphrase: PASSPHRASES.mainnet })).rejects.toMatchObject({
      kind: "network-mismatch",
    });
  });

  it("refuses a wallet set to another network", async () => {
    await expect(connectWallet(testnet!, fakeKit(PASSPHRASES.mainnet))).rejects.toMatchObject({ kind: "network-mismatch" });
    const kit = fakeKit(PASSPHRASES.mainnet);
    const signer = walletSigner(kit, A, testnet!);
    await expect(signer.signTransaction("XDR", { networkPassphrase: PASSPHRASES.testnet })).rejects.toThrow(/another network/);
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it("checks the wallet's network before signing an auth entry too", async () => {
    const kit = fakeKit(PASSPHRASES.mainnet);
    const signer = walletSigner(kit, A, testnet!);
    await expect(signer.signAuthEntry!("ENTRY", { networkPassphrase: PASSPHRASES.testnet })).rejects.toMatchObject({ kind: "network-mismatch" });
    expect(kit.signAuthEntry).not.toHaveBeenCalled();
  });

  it("works when its methods are passed around on their own, and can disconnect", async () => {
    const kit = fakeKit();
    const { signTransaction, disconnect } = walletSigner(kit, A, testnet!);
    await expect(signTransaction("XDR", { networkPassphrase: PASSPHRASES.mainnet })).rejects.toMatchObject({ kind: "network-mismatch" });
    expect(await signTransaction("XDR", { networkPassphrase: PASSPHRASES.testnet })).toBe("XDR+signed");
    await disconnect!();
    expect(kit.disconnect).toHaveBeenCalled();
  });

  it("is not offered on the devnet", async () => {
    await expect(connectWallet(devnet!, fakeKit())).rejects.toMatchObject({ kind: "config" });
  });

  it("maps a user's refusal to a wallet error", async () => {
    const kit = fakeKit();
    kit.signTransaction.mockRejectedValueOnce(new Error("User declined access"));
    const signer = walletSigner(kit, A, testnet!);
    await expect(signer.signTransaction("XDR", { networkPassphrase: PASSPHRASES.testnet })).rejects.toMatchObject({ kind: "wallet" });
  });
});

describe("token admin", () => {
  it("refuses a zero or negative amount before building an operation", async () => {
    const { TokenAdmin } = await import("../src/token/token-admin.ts");
    const { Asset } = await import("@stellar/stellar-sdk");
    const cb = devnetIdentities(devnet!, 0).centralBank;
    const asset = new Asset("USD", cb.address);
    const admin = new TokenAdmin({} as never, cb, { sacId: asset.contractId(PASSPHRASES.devnet), code: "USD", issuer: cb.address, asset });
    await expect(admin.issue(A, 0n)).rejects.toMatchObject({ kind: "token", title: "Invalid amount" });
    await expect(admin.clawback(A, -5n)).rejects.toMatchObject({ kind: "token", title: "Invalid amount" });
  });
});
