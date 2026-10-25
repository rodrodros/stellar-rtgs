// Wallets (Freighter and others) through Stellar Wallets Kit, for testnet and mainnet. The
// kit is browser-only and heavy, so it is imported only when a wallet is connected.
import { RtgsError, toRtgsError } from "../errors.ts";
import type { NetworkConfig } from "../network/networks.ts";
import { assertSamePassphrase, type Signer } from "./signer.ts";

/** The part of the kit's static API core uses; tests pass a fake. */
export interface WalletKit {
  authModal(): Promise<{ address: string }>;
  signTransaction(xdr: string, opts: { networkPassphrase: string; address: string }): Promise<{ signedTxXdr: string }>;
  signAuthEntry(entry: string, opts: { networkPassphrase: string; address: string }): Promise<{ signedAuthEntry: string }>;
  getNetwork(): Promise<{ networkPassphrase: string }>;
  disconnect(): Promise<void>;
  setNetwork?(passphrase: string): void;
}

let kitPromise: Promise<WalletKit> | undefined;

async function loadKit(net: NetworkConfig): Promise<WalletKit> {
  kitPromise ??= (async () => {
    const [{ StellarWalletsKit }, { defaultModules }] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit/sdk"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
    ]);
    StellarWalletsKit.init({ modules: defaultModules() });
    return StellarWalletsKit as unknown as WalletKit;
  })();
  const kit = await kitPromise;
  kit.setNetwork?.(net.passphrase);
  return kit;
}

/**
 * Where the wallet reports its network, refuse one that differs from the session's. Some
 * wallets can't report it; then the passphrase passed to each signature still binds it.
 */
async function assertWalletNetwork(kit: WalletKit, passphrase: string): Promise<void> {
  let reported: string | undefined;
  try {
    reported = (await kit.getNetwork()).networkPassphrase;
  } catch {
    return;
  }
  if (reported && reported !== passphrase) {
    throw new RtgsError(
      "network-mismatch",
      "Wallet is on another network",
      `The wallet is set to "${reported}"; switch it to "${passphrase}" and try again.`,
    );
  }
}

export function walletSigner(kit: WalletKit, address: string, net: NetworkConfig): Signer {
  // Methods close over `signer`, not `this`, so they work when passed around on their own.
  const signer: Signer = {
    kind: "wallet",
    address,
    networkPassphrase: net.passphrase,
    async signTransaction(xdr, opts) {
      assertSamePassphrase(signer, opts.networkPassphrase);
      await assertWalletNetwork(kit, net.passphrase);
      try {
        return (await kit.signTransaction(xdr, { networkPassphrase: net.passphrase, address })).signedTxXdr;
      } catch (e) {
        throw walletError(e);
      }
    },
    async signAuthEntry(entry, opts) {
      assertSamePassphrase(signer, opts.networkPassphrase);
      await assertWalletNetwork(kit, net.passphrase);
      try {
        return (await kit.signAuthEntry(entry, { networkPassphrase: net.passphrase, address })).signedAuthEntry;
      } catch (e) {
        throw walletError(e);
      }
    },
    disconnect: () => kit.disconnect(),
  };
  return signer;
}

function walletError(e: unknown): RtgsError {
  const mapped = toRtgsError(e);
  if (mapped.kind !== "rpc") return mapped;
  return new RtgsError("wallet", "Wallet failed", mapped.detail, { cause: e });
}

/** Opens the kit's wallet picker and returns a signer for the chosen account. Not on devnet. */
export async function connectWallet(net: NetworkConfig, kit?: WalletKit): Promise<Signer> {
  if (net.id === "devnet") {
    throw new RtgsError("config", "No wallets on the devnet", "Use the devnet identities instead.");
  }
  const k = kit ?? (await loadKit(net));
  let address: string;
  try {
    ({ address } = await k.authModal());
  } catch (e) {
    throw walletError(e);
  }
  await assertWalletNetwork(k, net.passphrase);
  return walletSigner(k, address, net);
}

/** Forgets the connected wallet, if the kit was ever loaded; `connectWallet` then asks again. */
export async function disconnectWallet(): Promise<void> {
  if (!kitPromise) return;
  await (await kitPromise).disconnect();
}
