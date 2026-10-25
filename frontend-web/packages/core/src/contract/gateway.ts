// The settlement contract, through the generated bindings. Reads simulate the public views
// (no signer, no fee); writes simulate, sign with a `Signer`, send and confirm. Every failure
// comes out as an `RtgsError`.
import { rpc, scValToNative, type contract } from "@stellar/stellar-sdk";
import { Client as SettlementClient } from "../generated/settlement.ts";
import { contractError, CONTRACT_ERRORS, RtgsError, toRtgsError } from "../errors.ts";
import { sdkSigning, type Signer, assertSamePassphrase } from "../signer/signer.ts";
import { outcomeEvents, type TxContext } from "../tx.ts";
import type { Config, Credit, Payment, Priority, Repo, TxOutcome } from "../types.ts";
import { fromPriority, toConfig, toCredit, toPayment, toRepo } from "./convert.ts";

type Assembled<T> = contract.AssembledTransaction<T>;
type Client = SettlementClient;

/** u64::MAX: an id no payment order or repo will have, for harmless probes. */
export const NO_ID = 18_446_744_073_709_551_615n;

function isResult(value: unknown): value is contract.Result<unknown> {
  return !!value && typeof value === "object" && typeof (value as { isErr?: unknown }).isErr === "function";
}

function unwrap<T>(value: unknown): T {
  if (!isResult(value)) return value as T;
  if (!value.isErr()) return value.unwrap() as T;
  const message = value.unwrapErr().message;
  const code = Object.entries(CONTRACT_ERRORS).find(([, t]) => t.name === message)?.[0];
  throw code ? contractError(Number(code)) : new RtgsError("contract", "Contract error", message);
}

/** The simulated result; throws the mapped error if simulation failed. */
export function simulated<T>(tx: Assembled<T>): T {
  const sim = tx.simulation;
  if (sim && rpc.Api.isSimulationError(sim)) throw toRtgsError(sim.error);
  let result: unknown;
  try {
    result = tx.result;
  } catch (e) {
    // The spec can lack a type a function returns (a stub's), so decode the raw value.
    if (e instanceof Error && /restore/i.test(e.message)) throw toRtgsError(e);
    const retval = tx.simulationData.result.retval;
    result = scValToNative(retval);
  }
  return unwrap<T>(result);
}

async function build<T>(make: () => Promise<Assembled<T>>): Promise<Assembled<T>> {
  try {
    return await make();
  } catch (e) {
    throw toRtgsError(e);
  }
}

export function settlementClient(ctx: TxContext & { contractId: string }, signer?: Signer): Client {
  return new SettlementClient({
    contractId: ctx.contractId,
    networkPassphrase: ctx.net.passphrase,
    rpcUrl: ctx.net.rpcUrl,
    allowHttp: ctx.net.allowHttp,
    server: ctx.server,
    ...(signer ? sdkSigning(signer) : {}),
  });
}

/** The contract's public views. */
export class SettlementReader {
  readonly client: Client;

  constructor(private readonly ctx: TxContext & { contractId: string }) {
    this.client = settlementClient(ctx);
  }

  private async view<T>(make: (c: Client) => Promise<Assembled<unknown>>): Promise<T> {
    return simulated(await build(() => make(this.client))) as T;
  }

  async config(): Promise<Config> {
    return toConfig(await this.view((c) => c.config()));
  }

  centralBank(): Promise<string> {
    return this.view((c) => c.central_bank());
  }

  async queuedCount(): Promise<number> {
    return Number(await this.view<number>((c) => c.queued_count()));
  }

  async balance(bank: string): Promise<bigint> {
    return BigInt(await this.view<bigint>((c) => c.balance({ bank })));
  }

  async payment(id: bigint): Promise<Payment | undefined> {
    const raw = await this.view<Record<string, unknown> | undefined | null>((c) => c.payment({ id }));
    return raw ? toPayment(raw) : undefined;
  }

  /** The ids `bank` has queued at `priority`, head first. */
  async queue(bank: string, priority: Priority): Promise<bigint[]> {
    const ids = await this.view<bigint[]>((c) => c.queue({ bank, priority: fromPriority(priority) }));
    return ids.map((id) => BigInt(id));
  }

  async credit(bank: string): Promise<Credit> {
    return toCredit(await this.view((c) => c.credit({ bank })));
  }

  async repo(id: bigint): Promise<Repo | undefined> {
    const raw = await this.view<Record<string, unknown> | undefined | null>((c) => c.repo({ id }));
    return raw ? toRepo(raw) : undefined;
  }

  /**
   * The newest payment order's id, or undefined if none was submitted. Ids are sequence
   * numbers from 0 (S11), so a galloping then binary search over `payment(id)` finds it.
   */
  async latestPaymentId(): Promise<bigint | undefined> {
    return latestId((id) => this.payment(id).then((p) => p !== undefined));
  }

  /** Payment orders `from`..`to` inclusive, skipping ids not issued; a few requests at a time. */
  async payments(range: { from: bigint; to: bigint }, concurrency = 8): Promise<Payment[]> {
    const ids: bigint[] = [];
    for (let id = range.from; id <= range.to; id++) ids.push(id);
    const found = await mapLimit(ids, concurrency, (id) => this.payment(id));
    return found.filter((p): p is Payment => p !== undefined);
  }
}

export async function latestId(exists: (id: bigint) => Promise<boolean>): Promise<bigint | undefined> {
  if (!(await exists(0n))) return undefined;
  let lo = 0n;
  let hi = 1n;
  while (await exists(hi)) {
    lo = hi;
    hi *= 2n;
  }
  // exists(lo) and !exists(hi)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A dry run's verdict: what the call would return, or why it would fail. */
export type Preview<T> = { ok: true; value: T; fee: bigint } | { ok: false; error: RtgsError };

/** The contract's entry points, signed by one `Signer`. */
export class SettlementWriter {
  readonly client: Client;

  constructor(
    private readonly ctx: TxContext & { contractId: string },
    readonly signer: Signer,
  ) {
    assertSamePassphrase(signer, ctx.net.passphrase);
    this.client = settlementClient(ctx, signer);
  }

  /** Simulates without sending. */
  async preview<T>(make: (c: Client) => Promise<Assembled<unknown>>): Promise<Preview<T>> {
    try {
      const tx = await build(() => make(this.client));
      const value = simulated(tx) as T;
      const sim = tx.simulation as rpc.Api.SimulateTransactionSuccessResponse;
      return { ok: true, value, fee: BigInt(sim.minResourceFee ?? 0) };
    } catch (e) {
      return { ok: false, error: toRtgsError(e) };
    }
  }

  /** Simulates, signs, sends and confirms; the outcome carries the call's value and events. */
  async send<T>(make: (c: Client) => Promise<Assembled<unknown>>): Promise<TxOutcome<T>> {
    const tx = await build(() => make(this.client));
    simulated(tx);
    let sent: contract.SentTransaction<unknown>;
    try {
      sent = await tx.signAndSend();
    } catch (e) {
      throw toRtgsError(e);
    }
    const response = sent.getTransactionResponse;
    const txHash = sent.sendTransactionResponse?.hash ?? "";
    if (!response || response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new RtgsError("transaction", "Transaction failed", `Transaction ${txHash} did not succeed.`);
    }
    return {
      txHash,
      ledger: response.ledger,
      closedAt: Number(response.createdAt),
      value: unwrap<T>(sent.result),
      events: outcomeEvents(response, txHash, this.ctx.contractId),
    };
  }
}
