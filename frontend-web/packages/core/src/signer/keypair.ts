// Devnet keypairs: held in the browser, derived from a demo seed so that every app derives
// the same central bank and banks without sharing storage. They never sign for another network.
import { contract, hash, Keypair } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { RtgsError } from "../errors.ts";
import { DEFAULT_DEVNET_SEED, PASSPHRASES, type NetworkConfig } from "../network/networks.ts";
import { assertSamePassphrase, type Signer } from "./signer.ts";

const DEVNET = PASSPHRASES.devnet;

function assertDevnet(passphrase: string): void {
  if (passphrase !== DEVNET) {
    throw new RtgsError(
      "network-mismatch",
      "Devnet keys only",
      "Keypairs held in the browser sign only on the devnet; use a wallet on testnet and mainnet.",
    );
  }
}

export function keypairSigner(keypair: Keypair, net: Pick<NetworkConfig, "passphrase">, label?: string): Signer {
  assertDevnet(net.passphrase);
  const sdk = contract.basicNodeSigner(keypair, DEVNET);
  // Methods close over `signer`, not `this`, so they work when passed around on their own.
  const signer: Signer = {
    kind: "devnet-keypair",
    address: keypair.publicKey(),
    networkPassphrase: DEVNET,
    ...(label === undefined ? {} : { label }),
    async signTransaction(xdr, opts) {
      assertSamePassphrase(signer, opts.networkPassphrase);
      return (await sdk.signTransaction(xdr, { networkPassphrase: DEVNET })).signedTxXdr;
    },
    async signAuthEntry(entry, opts) {
      assertSamePassphrase(signer, opts.networkPassphrase);
      return (await sdk.signAuthEntry(entry, { networkPassphrase: DEVNET })).signedAuthEntry;
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

/** The devnet's central bank (also the cash token's issuer) and `count` banks. */
export function devnetIdentities(net: Pick<NetworkConfig, "passphrase" | "devnetSeed">, count = 3): DevnetIdentities {
  assertDevnet(net.passphrase);
  const seed = net.devnetSeed ?? DEFAULT_DEVNET_SEED;
  return {
    centralBank: keypairSigner(deriveDevnetKeypair(seed, CENTRAL_BANK_LABEL), net, "Central bank"),
    banks: Array.from({ length: count }, (_, i) =>
      keypairSigner(deriveDevnetKeypair(seed, bankLabel(i + 1)), net, devnetBankName(i + 1)),
    ),
  };
}
