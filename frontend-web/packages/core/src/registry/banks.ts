// The bank registry the apps see (spec fact 2): the union of the banks listed in config, those
// the central bank registered on its account (registry/ledger.ts), the devnet identities, and
// any address the event feed mentions. The central bank and the contract are not banks.
import type { BankEntry, NetworkConfig } from "../network/networks.ts";
import { deriveDevnetKeypair, bankLabel } from "../signer/keypair.ts";
import { DEFAULT_DEVNET_SEED } from "../network/networks.ts";
import type { Signer } from "../signer/signer.ts";
import type { TxContext } from "../tx.ts";
import type { TxOutcome } from "../types.ts";
import { readLedgerBanks, registerBank, unregisterBank } from "./ledger.ts";

export type BankSource = "config" | "ledger" | "devnet" | "events";

export interface Bank {
  address: string;
  name?: string;
  sources: BankSource[];
}

/** How many devnet identities to recognise by address. */
const DEVNET_LABELS = 20;

export class BankRegistry {
  private banks = new Map<string, Bank>();
  private readonly listeners = new Set<(banks: Bank[]) => void>();
  private devnetNames: Map<string, string> | undefined;

  constructor(
    private readonly ctx: TxContext,
    private readonly net: NetworkConfig,
    readonly centralBank: string,
    private readonly contractId: string,
  ) {
    for (const b of net.banks) this.add(b, "config");
  }

  list(): Bank[] {
    return [...this.banks.values()];
  }

  get(address: string): Bank | undefined {
    return this.banks.get(address);
  }

  /** A display name: the registered or configured name, else a shortened address. */
  nameOf(address: string): string {
    if (address === this.centralBank) return "Central bank";
    return this.banks.get(address)?.name ?? `${address.slice(0, 4)}…${address.slice(-4)}`;
  }

  subscribe(listener: (banks: Bank[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const banks = this.list();
    for (const l of this.listeners) l(banks);
  }

  /** Names devnet identities ("Bank 2") by address, so even unregistered ones read well. */
  private devnetName(address: string): string | undefined {
    if (this.net.id !== "devnet") return undefined;
    if (!this.devnetNames) {
      const seed = this.net.devnetSeed ?? DEFAULT_DEVNET_SEED;
      this.devnetNames = new Map(
        Array.from({ length: DEVNET_LABELS }, (_, i) => [deriveDevnetKeypair(seed, bankLabel(i + 1)).publicKey(), `Bank ${i + 1}`]),
      );
    }
    return this.devnetNames.get(address);
  }

  private add(entry: BankEntry, source: BankSource): boolean {
    if (entry.address === this.centralBank || entry.address === this.contractId) return false;
    const known = this.banks.get(entry.address);
    const devnetName = this.devnetName(entry.address);
    const name = entry.name ?? known?.name ?? devnetName;
    const set = new Set<BankSource>(known?.sources ?? []).add(source);
    if (devnetName) set.add("devnet");
    const sources = [...set];
    const next: Bank = name ? { address: entry.address, name, sources } : { address: entry.address, sources };
    const changed = !known || known.name !== next.name || known.sources.length !== next.sources.length;
    if (changed) this.banks.set(entry.address, next);
    return changed;
  }

  /** Reads the registry on the central bank's account and merges it in. */
  async load(): Promise<Bank[]> {
    const ledger = await readLedgerBanks(this.ctx, this.centralBank);
    let changed = false;
    for (const b of ledger) changed = this.add(b, "ledger") || changed;
    if (changed) this.emit();
    return this.list();
  }

  /** Adds addresses seen in events; returns the ones that were new. */
  observe(addresses: Iterable<string>): string[] {
    const added: string[] = [];
    let changed = false;
    for (const address of addresses) {
      const isNew = !this.banks.has(address);
      if (this.add({ address }, "events")) {
        changed = true;
        if (isNew) added.push(address);
      }
    }
    if (changed) this.emit();
    return added;
  }

  /** The central bank registers (or renames) a bank on its account. */
  async register(cb: Signer, entry: { address: string; name?: string }): Promise<TxOutcome> {
    const outcome = await registerBank(this.ctx, cb, this.centralBank, entry);
    this.add(entry, "ledger");
    this.emit();
    return outcome;
  }

  async unregister(cb: Signer, address: string): Promise<TxOutcome> {
    const outcome = await unregisterBank(this.ctx, cb, this.centralBank, address);
    const known = this.banks.get(address);
    if (known) {
      const sources = known.sources.filter((s) => s !== "ledger");
      if (sources.length) this.banks.set(address, { ...known, sources });
      else this.banks.delete(address);
    }
    this.emit();
    return outcome;
  }
}
