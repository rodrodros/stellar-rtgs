// A session: one network, one settlement contract. It is immutable; switching networks means
// `dispose()` and `connect()` again, which also drops every signer bound to the old network.
import { Operation } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { cachedCapabilities, capabilityOverrides, type Capabilities } from "./capabilities.ts";
import { fromPriority } from "./contract/convert.ts";
import { SettlementReader, SettlementWriter, mapLimit, type Preview } from "./contract/gateway.ts";
import { RtgsError } from "./errors.ts";
import { EventFeed, type FeedOptions } from "./events/feed.ts";
import { analyseQueues, type BankQueues } from "./model/queues.ts";
import { RtgsStore, type StoreOptions } from "./model/store.ts";
import { readEnv, type Env, type NetworkConfig } from "./network/networks.ts";
import { BankRegistry } from "./registry/banks.ts";
import { discoverDeployment } from "./registry/ledger.ts";
import { assertNetwork, latestLedger, rpcServer, type LedgerClock, type RpcServer } from "./rpc.ts";
import { devnetIdentities } from "./signer/keypair.ts";
import { assertSamePassphrase, type Signer } from "./signer/signer.ts";
import { CashTokenReader, readCashToken, tokenOfContract, type CashToken } from "./token/cash-token.ts";
import { TokenAdmin } from "./token/token-admin.ts";
import { sendClassic, type TxContext } from "./tx.ts";
import type { Config, Credit, Payment, Priority, TxOutcome } from "./types.ts";

export interface ConnectOptions {
  /** The settlement contract; else the network's, else discovered from the central bank. */
  contractId?: string;
  /** Required to connect to mainnet: the app's confirmation. */
  acknowledgeMainnet?: true;
  /** Build env, for `VITE_RTGS_CAPABILITIES` overrides and a config fallback for the token. */
  env?: Env;
}

/** A bank as the views show it now. */
export interface BankView {
  address: string;
  name?: string;
  /** Settlement balance, in the contract (custody balance). */
  balance: bigint;
  /** Queued payment orders, head first, per priority class. */
  queues: { urgent: Payment[]; normal: Payment[] };
  analysis: BankQueues;
  /** Undefined while `credit` is a stub. */
  credit?: Credit;
}

/** The contract's views, plus composites the apps need. */
export class RtgsReader extends SettlementReader {
  constructor(
    ctx: TxContext & { contractId: string },
    private readonly capabilities: Capabilities,
  ) {
    super(ctx);
  }

  /** Credit, or undefined while the deployed contract's `credit` is a stub. */
  async creditIfAvailable(bank: string): Promise<Credit | undefined> {
    return this.capabilities.credit === "available" ? this.credit(bank) : undefined;
  }

  /** Balance, both queues as payment orders, what blocks their heads, and credit. */
  async bank(address: string, opts: { config?: Config; known?: Map<bigint, Payment> } = {}): Promise<BankView> {
    const [balance, urgentIds, normalIds, credit] = await Promise.all([
      this.balance(address),
      this.queue(address, "urgent"),
      this.queue(address, "normal"),
      this.creditIfAvailable(address),
    ]);
    const load = async (ids: bigint[]) =>
      (await mapLimit(ids, 8, async (id) => opts.known?.get(id) ?? this.payment(id))).filter((p): p is Payment => !!p);
    const queues = { urgent: await load(urgentIds), normal: await load(normalIds) };
    const view: BankView = { address, balance, queues, analysis: analyseQueues(balance, queues, opts.config) };
    if (credit) view.credit = credit;
    return view;
  }
}

/** The contract's entry points in domain terms, signed by one signer. */
export class RtgsActor {
  readonly address: string;
  private readonly writer: SettlementWriter;

  constructor(
    private readonly ctx: TxContext & { contractId: string },
    readonly signer: Signer,
    private readonly cashToken: CashToken,
  ) {
    this.writer = new SettlementWriter(ctx, signer);
    this.address = signer.address;
  }

  /** Moves cash tokens from the signer's holding into its settlement balance (A11). */
  deposit(amount: bigint): Promise<TxOutcome> {
    return this.writer.send((c) => c.deposit({ bank: this.address, amount }));
  }

  withdraw(amount: bigint): Promise<TxOutcome> {
    return this.writer.send((c) => c.withdraw({ bank: this.address, amount }));
  }

  /**
   * Submits a payment order (A1). `disposition` says whether it settled at once or queued,
   * read from the transaction's own events.
   */
  async submit(order: { to: string; amount: bigint; priority: Priority }): Promise<TxOutcome<{ id: bigint; disposition: "settled" | "queued" }>> {
    const outcome = await this.writer.send<bigint>((c) =>
      c.submit({ from: this.address, to: order.to, amount: order.amount, priority: fromPriority(order.priority) }),
    );
    const id = BigInt(outcome.value);
    const settled = outcome.events.some((e) => e.type === "Settled" && e.id === id);
    return { ...outcome, value: { id, disposition: settled ? "settled" : "queued" } };
  }

  /** Revokes a queued payment order the signer sent (A6, ADR-0016). */
  revoke(id: bigint): Promise<TxOutcome> {
    return this.writer.send((c) => c.revoke({ id }));
  }

  /** Moves a queued payment order to the other priority class, keeping its place by age (A8). */
  reprioritise(id: bigint, priority: Priority): Promise<TxOutcome> {
    return this.writer.send((c) => c.reprioritise({ id, priority: fromPriority(priority) }));
  }

  /** Repays a repo (A13), or a penalty repo (A20), as the signer. */
  repay(repoId: bigint, amount: bigint): Promise<TxOutcome> {
    return this.writer.send((c) => c.repay({ actor: this.address, repo_id: repoId, amount }));
  }

  /** Central bank: sets a bank's collateral value after haircuts (A14). */
  setCollateral(bank: string, value: bigint): Promise<TxOutcome> {
    return this.writer.send((c) => c.set_collateral({ bank, value }));
  }

  /** Central bank: opens an intraday repo for a bank (A12). */
  async openRepo(bank: string, amount: bigint): Promise<TxOutcome<{ repoId: bigint }>> {
    const outcome = await this.writer.send<bigint>((c) => c.open_repo({ bank, amount }));
    return { ...outcome, value: { repoId: BigInt(outcome.value) } };
  }

  /** Keeper (anyone): rejects a queued payment order past its expiry (A5, ADR-0015). */
  expire(id: bigint): Promise<TxOutcome> {
    return this.writer.send((c) => c.expire({ id }));
  }

  /** Keeper (anyone): turns a repo past its term into a penalty repo (ADR-0014). */
  convertOverdue(repoId: bigint): Promise<TxOutcome> {
    return this.writer.send((c) => c.convert_overdue({ repo_id: repoId }));
  }

  /** Opens the signer's trustline for the cash token; the central bank must then authorize it. */
  openTrustline(): Promise<TxOutcome> {
    return sendClassic(this.ctx, this.signer, [Operation.changeTrust({ asset: this.cashToken.asset })]);
  }

  /** Dry runs: what each call would return, or the error it would meet. Nothing is sent. */
  readonly simulate = {
    deposit: (amount: bigint): Promise<Preview<void>> => this.writer.preview((c) => c.deposit({ bank: this.address, amount })),
    withdraw: (amount: bigint): Promise<Preview<void>> => this.writer.preview((c) => c.withdraw({ bank: this.address, amount })),
    submit: (o: { to: string; amount: bigint; priority: Priority }): Promise<Preview<bigint>> =>
      this.writer.preview((c) => c.submit({ from: this.address, to: o.to, amount: o.amount, priority: fromPriority(o.priority) })),
    revoke: (id: bigint): Promise<Preview<void>> => this.writer.preview((c) => c.revoke({ id })),
    reprioritise: (id: bigint, priority: Priority): Promise<Preview<void>> =>
      this.writer.preview((c) => c.reprioritise({ id, priority: fromPriority(priority) })),
    repay: (repoId: bigint, amount: bigint): Promise<Preview<void>> =>
      this.writer.preview((c) => c.repay({ actor: this.address, repo_id: repoId, amount })),
    setCollateral: (bank: string, value: bigint): Promise<Preview<void>> => this.writer.preview((c) => c.set_collateral({ bank, value })),
    openRepo: (bank: string, amount: bigint): Promise<Preview<bigint>> => this.writer.preview((c) => c.open_repo({ bank, amount })),
    expire: (id: bigint): Promise<Preview<void>> => this.writer.preview((c) => c.expire({ id })),
    convertOverdue: (repoId: bigint): Promise<Preview<void>> => this.writer.preview((c) => c.convert_overdue({ repo_id: repoId })),
  };
}

export class RtgsSession {
  readonly read: RtgsReader;
  readonly registry: BankRegistry;
  readonly token: CashTokenReader;
  private readonly ctx: TxContext & { contractId: string };
  private sharedStore: { store: RtgsStore; users: number; key: string } | undefined;
  private readonly ownStores = new Set<RtgsStore>();
  private disposed = false;
  private readonly feeds = new Set<EventFeed>();

  constructor(
    readonly network: NetworkConfig,
    readonly server: RpcServer,
    readonly contractId: string,
    readonly centralBank: string,
    readonly cashToken: CashToken,
    readonly capabilities: Capabilities,
  ) {
    this.ctx = { server, net: network, contractId };
    this.read = new RtgsReader(this.ctx, capabilities);
    this.registry = new BankRegistry(this.ctx, network, centralBank, contractId);
    this.token = new CashTokenReader(this.ctx, cashToken);
  }

  private assertLive(): void {
    if (this.disposed) throw new RtgsError("config", "Session closed", "This session was disposed; connect again.");
  }

  /** The entry points, signed by `signer`. Refuses a signer bound to another network. */
  as(signer: Signer): RtgsActor {
    this.assertLive();
    assertSamePassphrase(signer, this.network.passphrase);
    return new RtgsActor(this.ctx, signer, this.cashToken);
  }

  /** Cash token administration; refuses a signer that isn't the token's admin. */
  tokenAdmin(signer: Signer): TokenAdmin {
    this.assertLive();
    assertSamePassphrase(signer, this.network.passphrase);
    return new TokenAdmin(this.ctx, signer, this.cashToken);
  }

  /** A new event feed; `includeToken` adds the cash token's SAC events. Stopped on dispose. */
  events(options: FeedOptions = {}): EventFeed {
    this.assertLive();
    return new EventFeed({ server: this.server, contractId: this.contractId, sacId: this.cashToken.sacId }, options, {
      onStart: (feed) => this.feeds.add(feed),
      onStop: (feed) => this.feeds.delete(feed),
    });
  }

  /**
   * The read model. Without `feed.from` it is the session's shared store, created with the
   * first caller's options; a later caller asking for other options gets an error rather than
   * silently different behaviour. With `feed.from` (a replay from a chosen ledger or cursor) it
   * is a store of its own. Either way each caller must `release()` it; a store stops when its
   * last user releases it, or on dispose.
   */
  store(options: StoreOptions = {}): { store: RtgsStore; release: () => void } {
    this.assertLive();
    if (options.feed?.from !== undefined) {
      const store = new RtgsStore(this, options);
      this.ownStores.add(store);
      store.start();
      let released = false;
      return {
        store,
        release: () => {
          if (released) return;
          released = true;
          store.stop();
          this.ownStores.delete(store);
        },
      };
    }
    const key = JSON.stringify(options);
    if (this.sharedStore && this.sharedStore.key !== key) {
      throw new RtgsError(
        "config",
        "Store options differ",
        "The session's shared store was created with other options; pass feed.from for a store of your own.",
      );
    }
    if (!this.sharedStore) {
      const store = new RtgsStore(this, options);
      this.sharedStore = { store, users: 0, key };
      store.start();
    }
    const shared = this.sharedStore;
    shared.users += 1;
    let released = false;
    return {
      store: shared.store,
      release: () => {
        if (released) return;
        released = true;
        shared.users -= 1;
        if (shared.users === 0 && this.sharedStore === shared) {
          shared.store.stop();
          this.sharedStore = undefined;
        }
      },
    };
  }

  latestLedger(): Promise<LedgerClock> {
    return latestLedger(this.server);
  }

  dispose(): void {
    this.disposed = true;
    for (const feed of [...this.feeds]) feed.stop();
    this.sharedStore?.store.stop();
    this.sharedStore = undefined;
    for (const store of this.ownStores) store.stop();
    this.ownStores.clear();
  }
}

/**
 * Connects to a network's settlement contract: checks that the RPC serves the expected
 * network, finds the contract, reads its central bank and cash token, and probes which entry
 * points it implements.
 */
export async function connect(net: NetworkConfig, options: ConnectOptions = {}): Promise<RtgsSession> {
  if (net.id === "mainnet" && options.acknowledgeMainnet !== true) {
    throw new RtgsError("mainnet-not-acknowledged", "Mainnet needs confirmation", "Confirm that you mean to use mainnet, with real funds.");
  }
  const server = rpcServer(net);
  await assertNetwork(server, net);
  const ctx: TxContext = { server, net };

  let contractId = options.contractId ?? net.contractId;
  if (!contractId) {
    const cb = net.centralBank ?? (net.id === "devnet" ? devnetIdentities(net, 0).centralBank.address : undefined);
    if (cb) contractId = (await discoverDeployment(ctx, cb)).contractId;
  }
  if (!contractId) {
    throw new RtgsError(
      "config",
      "No settlement contract",
      net.id === "devnet"
        ? "Nothing is deployed on this devnet yet: run the bootstrap, or set the contract id."
        : `Set the ${net.label} contract id.`,
    );
  }
  let instance;
  try {
    instance = await server.getContractInstance(contractId);
  } catch (e) {
    throw new RtgsError(
      "config",
      "No settlement contract",
      `Nothing is deployed at ${contractId} on ${net.label}; it may have been reset. Clear the contract id or run the bootstrap.`,
      { cause: e },
    );
  }
  const wasmHash = instance.executable.type === "contractExecutableWasm" ? Buffer.from(instance.executable.wasmHash.value).toString("hex") : "";
  const reader = new SettlementReader({ ...ctx, contractId });
  const centralBank = await reader.centralBank();
  const env = options.env ?? {};
  const sacId = await tokenOfContract(ctx, contractId, readEnv(env, `${net.id.toUpperCase()}_TOKEN_ID`), instance);
  const cashToken = await readCashToken(ctx, sacId);
  const capabilities = await cachedCapabilities(`${net.passphrase}|${contractId}|${wasmHash}`, reader, centralBank, capabilityOverrides(env));
  return new RtgsSession(net, server, contractId, centralBank, cashToken, capabilities);
}
