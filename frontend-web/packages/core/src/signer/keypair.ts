// Demo keypairs: held in the browser, derived from a demo seed so that every app derives
// the same central bank and banks without sharing storage. They sign on the devnet, and on the
// testnet when a seed is configured for it; never on mainnet.
import { contract, hash, Keypair } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { RtgsError } from "../errors.ts";
import { DEFAULT_DEVNET_SEED, PASSPHRASES, type NetworkConfig } from "../network/networks.ts";
import { assertSamePassphrase, type Signer } from "./signer.ts";

const DEMO_PASSPHRASES = [PASSPHRASES.devnet, PASSPHRASES.testnet];

function assertDemoNetwork(passphrase: string): void {
  if (!DEMO_PASSPHRASES.includes(passphrase)) {
    throw new RtgsError(
      "network-mismatch",
      "Devnet and testnet keys only",
      "Keypairs held in the browser sign only on the devnet and testnet; use a wallet on mainnet.",
    );
  }
}

export function keypairSigner(keypair: Keypair, net: Pick<NetworkConfig, "passphrase">, label?: string): Signer {
  assertDemoNetwork(net.passphrase);
  const passphrase = net.passphrase;
  const sdk = contract.basicNodeSigner(keypair, passphrase);
  // Methods close over `signer`, not `this`, so they work when passed around on their own.
  const signer: Signer = {
    kind: "devnet-keypair",
    address: keypair.publicKey(),
    networkPassphrase: passphrase,
    ...(label === undefined ? {} : { label }),
    async signTransaction(xdr, opts) {
      assertSamePassphrase(signer, opts.networkPassphrase);
      return (await sdk.signTransaction(xdr, { networkPassphrase: passphrase })).signedTxXdr;
    },
    async signAuthEntry(entry, opts) {
      assertSamePassphrase(signer, opts.networkPassphrase);
      return (await sdk.signAuthEntry(entry, { networkPassphrase: passphrase })).signedAuthEntry;
    },
  };
  return signer;
}

/** `sha256(seed + ":" + label)` as an ed25519 seed. Public by design: devnet demo keys. */
export function deriveDevnetKeypair(seed: string, label: string): Keypair {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(`${seed}:${label}`, "utf8")));
}

export const CENTRAL_BANK_LABEL = "central-bank";
export const bankLabel = (n: number) => `bank-${n}`;

const DEVNET_BANK_NAMES = ["Dime Lords", "Owl Street", "Penny Lane"];
/** The display name of devnet bank `n` (1-based); past the named ones, "Bank n". */
export const devnetBankName = (n: number) => DEVNET_BANK_NAMES[n - 1] ?? `Bank ${n}`;

export interface DevnetIdentities {
  centralBank: Signer;
  /** bank-1 ... bank-N, in order. */
  banks: Signer[];
}

/**
 * The demo central bank (also the cash token's issuer) and `count` banks. The devnet falls back
 * to the public demo seed; the testnet needs its own seed configured (`*_TESTNET_SEED`).
 */
export function devnetIdentities(net: Pick<NetworkConfig, "passphrase" | "devnetSeed">, count = 3): DevnetIdentities {
  assertDemoNetwork(net.passphrase);
  const seed = net.devnetSeed ?? (net.passphrase === PASSPHRASES.devnet ? DEFAULT_DEVNET_SEED : undefined);
  if (seed === undefined) {
    throw new RtgsError("config", "No demo seed", "Set a testnet seed to derive the demo identities on the testnet.");
  }
  return {
    centralBank: keypairSigner(deriveDevnetKeypair(seed, CENTRAL_BANK_LABEL), net, "Central bank"),
    banks: Array.from({ length: count }, (_, i) =>
      keypairSigner(deriveDevnetKeypair(seed, bankLabel(i + 1)), net, devnetBankName(i + 1)),
    ),
  };
}
