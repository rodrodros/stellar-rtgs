import { RtgsError } from "../errors.ts";

/**
 * One interface for every way to sign: a devnet keypair held in the browser, or a wallet
 * through Stellar Wallets Kit (testnet, mainnet). A signer is bound to one network passphrase
 * at creation and refuses to sign for any other, so switching networks can't make it sign
 * for the wrong one.
 */
export interface Signer {
  readonly kind: "devnet-keypair" | "wallet";
  /** The account's G-address. */
  readonly address: string;
  readonly networkPassphrase: string;
  /** A display name, e.g. "Central bank" or "Bank 2". */
  readonly label?: string;
  /** Signs a transaction envelope (base64 XDR) and returns the signed envelope. */
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
  /** Signs a Soroban authorization entry preimage (base64 XDR), for calls another account submits. */
  signAuthEntry?(entryXdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

export function assertSamePassphrase(signer: Pick<Signer, "networkPassphrase" | "address">, passphrase: string): void {
  if (passphrase !== signer.networkPassphrase) {
    throw new RtgsError(
      "network-mismatch",
      "Signer is for another network",
      `${signer.address} signs for "${signer.networkPassphrase}", not "${passphrase}". Reconnect after switching networks.`,
    );
  }
}

/** Adapts a `Signer` to the SDK's `signTransaction` / `signAuthEntry` options. */
export function sdkSigning(signer: Signer) {
  return {
    publicKey: signer.address,
    signTransaction: async (xdr: string, opts?: { networkPassphrase?: string }) => ({
      signedTxXdr: await signer.signTransaction(xdr, { networkPassphrase: opts?.networkPassphrase ?? signer.networkPassphrase }),
      signerAddress: signer.address,
    }),
    ...(signer.signAuthEntry
      ? {
          signAuthEntry: async (entry: string, opts?: { networkPassphrase?: string }) => ({
            signedAuthEntry: await signer.signAuthEntry!(entry, {
              networkPassphrase: opts?.networkPassphrase ?? signer.networkPassphrase,
            }),
            signerAddress: signer.address,
          }),
        }
      : {}),
  };
}
