// The bank registry the apps see (spec fact 2): the union of the banks listed in config, those
// the central bank registered on its account (registry/ledger.ts), the devnet identities, and
// any address the event feed mentions. The central bank and the contract are not banks.
import { notifyAll } from "../listeners.ts";
import { DEFAULT_DEVNET_SEED, type NetworkConfig } from "../network/networks.ts";
import { deriveDevnetKeypair, bankLabel, devnetBankName } from "../signer/keypair.ts";
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
  /** Each source's contribution, kept apart so a reload can take banks and names away again. */
  private readonly fromConfig = new Map<string, string | undefined>();
  private fromLedger = new Map<string, string | undefined>();
  private readonly fromEvents = new Set<string>();
  private banks = new Map<string, Bank>();
  /** `list()`'s array, rebuilt only when the registry changes, so it is stable for React. */
  private listed: Bank[] = [];
  /** Bumped by every register and unregister, so an older ledger read can't undo them. */
  private writes = 0;
  private readonly listeners = new Set<(banks: Bank[]) => void>();
  private devnetNames: Map<string, string> | undefined;

  constructor(
    private readonly ctx: TxContext,
    private readonly net: NetworkConfig,
    readonly centralBank: string,
    private readonly contractId: string,
  ) {
    for (const b of net.banks) this.fromConfig.set(b.address, b.name);
    this.recompute();
  }

  list(): Bank[] {
    return this.listed;
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

  /** Names devnet identities ("Owl Street") by address, so even unregistered ones read well. */
  private devnetName(address: string): string | undefined {
    if (this.net.id !== "devnet") return undefined;
    if (!this.devnetNames) {
      const seed = this.net.devnetSeed ?? DEFAULT_DEVNET_SEED;
      this.devnetNames = new Map(
        Array.from({ length: DEVNET_LABELS }, (_, i) => [deriveDevnetKeypair(seed, bankLabel(i + 1)).publicKey(), devnetBankName(i + 1)]),
      );
    }
    return this.devnetNames.get(address);
  }

  /**
   * Merges the sources: the ledger registry's name first, then config's, then the devnet
   * label. Notifies listeners if anything changed.
   */
  private recompute(): void {
    const next = new Map<string, Bank>();
    const addresses = new Set([...this.fromConfig.keys(), ...this.fromLedger.keys(), ...this.fromEvents]);
    for (const address of addresses) {
      if (address === this.centralBank || address === this.contractId) continue;
      const sources: BankSource[] = [];
      if (this.fromConfig.has(address)) sources.push("config");
      if (this.fromLedger.has(address)) sources.push("ledger");
      if (this.fromEvents.has(address)) sources.push("events");
      const devnetName = this.devnetName(address);
      if (devnetName) sources.push("devnet");
      const name = this.fromLedger.get(address) ?? this.fromConfig.get(address) ?? devnetName;
      next.set(address, name ? { address, name, sources } : { address, sources });
    }
    const changed = JSON.stringify([...next.values()]) !== JSON.stringify([...this.banks.values()]);
    this.banks = next;
    if (changed) {
      this.listed = [...next.values()];
      notifyAll(this.listeners, this.list());
    }
  }

  /**
   * Reads the registry on the central bank's account. It replaces the ledger's previous
   * contribution, so a bank another app unregistered or renamed is updated here too.
   */
  async load(): Promise<Bank[]> {
    let ledger;
    // A read that a register or unregister overtook is stale: read again.
    for (;;) {
      const writes = this.writes;
      ledger = await readLedgerBanks(this.ctx, this.centralBank);
      if (writes === this.writes) break;
    }
    this.fromLedger = new Map(ledger.map((b) => [b.address, b.name]));
    this.recompute();
    return this.list();
  }

  /** Adds addresses seen in events; returns the ones that were new. */
  observe(addresses: Iterable<string>): string[] {
    const added: string[] = [];
    let changed = false;
    for (const address of addresses) {
      if (this.fromEvents.has(address)) continue;
      this.fromEvents.add(address);
      changed = true;
      if (!this.banks.has(address) && address !== this.centralBank && address !== this.contractId) added.push(address);
    }
    if (changed) this.recompute();
    return added;
  }

  /** The central bank registers (or renames) a bank on its account. */
  async register(cb: Signer, entry: { address: string; name?: string }): Promise<TxOutcome> {
    const outcome = await registerBank(this.ctx, cb, this.centralBank, entry);
    this.writes += 1;
    this.fromLedger.set(entry.address, entry.name?.trim() || undefined);
    this.recompute();
    return outcome;
  }

  async unregister(cb: Signer, address: string): Promise<TxOutcome> {
    const outcome = await unregisterBank(this.ctx, cb, this.centralBank, address);
    this.writes += 1;
    this.fromLedger.delete(address);
    this.recompute();
    return outcome;
  }
}
