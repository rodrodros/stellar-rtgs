// Building, signing, sending and confirming transactions. A transaction is final once the
// ledger that applies it closes (ADR-0005), so every send polls until RPC reports it.
import { Account, BASE_FEE, contract, Keypair, rpc, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import { retryTransient, RtgsError, toRtgsError } from "./errors.ts";
import { contractIdOf, decodeEvent, eventId } from "./events/decode.ts";
import type { NetworkConfig } from "./network/networks.ts";
import type { RpcServer } from "./rpc.ts";
import { assertSamePassphrase, type Signer } from "./signer/signer.ts";
import type { RtgsEvent, TxOutcome } from "./types.ts";

const TIMEOUT_SECS = 60;
const POLL_ATTEMPTS = 60;

export interface TxContext {
  server: RpcServer;
  net: NetworkConfig;
  /** The settlement contract, whose events a transaction outcome carries. */
  contractId?: string;
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Horizon-style result codes (`tx_bad_seq`, `op_no_trust`) from a transaction result. */
export function resultCodes(result: xdr.TransactionResult): string[] {
  const inner = result.result;
  const codes = [snake(inner.type)];
  if (inner.type !== "txFailed" && inner.type !== "txSuccess") return codes;
  for (const op of inner.results) {
    if (op.type !== "opInner") {
      codes.push(snake(op.type));
      continue;
    }
    // e.g. tr.type "payment", tr.value.type "paymentNoTrust" -> "op_no_trust"
    const opType: string = op.tr.type;
    const code: string = (op.tr.value as { type: string }).type;
    codes.push(`op${snake(code.startsWith(opType) ? code.slice(opType.length) : code)}`);
  }
  return codes;
}

function failure(codes: string[], cause?: unknown): RtgsError {
  const mapped = toRtgsError(codes.join(" "));
  if (mapped.kind !== "rpc") return new RtgsError(mapped.kind, mapped.title, mapped.detail, { cause });
  return new RtgsError("transaction", "Transaction failed", `The network refused it: ${codes.join(", ")}.`, { cause });
}

/**
 * The contract error a failed Soroban transaction reports in its diagnostic events, preferring
 * one raised by `contractId`.
 */
export function diagnosticContractError(response: { diagnosticEventsXdr?: xdr.DiagnosticEvent[] }, contractId?: string): number | undefined {
  let any: number | undefined;
  for (const diagnostic of response.diagnosticEventsXdr ?? []) {
    const body = diagnostic.event.body.v0;
    for (const value of [...body.topics, body.data]) {
      if (value.type !== "scvError" || value.error.type !== "sceContract") continue;
      if (contractId && contractIdOf(diagnostic.event) === contractId) return value.error.contractCode;
      any ??= value.error.contractCode;
    }
  }
  return any;
}

/**
 * Whether a failed transaction reached for storage its simulation didn't foresee (the host's
 * `Error(Storage, ExceededLimit)`: a key outside the footprint, or more bytes than it reserved).
 * Another transaction changed the contract's state in between, e.g. took the payment id this
 * one's simulation expected, or queued a payment its eager closure now reads.
 */
export function footprintRace(response: { diagnosticEventsXdr?: xdr.DiagnosticEvent[] }): boolean {
  for (const diagnostic of response.diagnosticEventsXdr ?? []) {
    const body = diagnostic.event.body.v0;
    for (const value of [...body.topics, body.data]) {
      if (value.type === "scvError" && value.error.type === "sceStorage" && value.error.code.name === "scecExceededLimit") return true;
    }
  }
  return false;
}

/** Why a transaction failed when applied: its contract error if it has one, else its result codes. */
export function failedTransaction(
  response: rpc.Api.GetFailedTransactionResponse,
  contractId: string | undefined,
  source: "settlement" | "sac" = "settlement",
): RtgsError {
  const code = diagnosticContractError(response, contractId);
  if (code !== undefined) return toRtgsError(`Error(Contract, #${code})`, source);
  const codes = resultCodes(response.resultXdr);
  // Past a successful simulation, running out of the resources it reserved means the same:
  // the state grew in between (e.g. the eager closure now has more queue to work through).
  if (footprintRace(response) || codes.includes("op_resource_limit_exceeded")) {
    return new RtgsError(
      "transaction",
      "State changed",
      "Another transaction changed the settlement contract's state after this one was prepared, so it no longer fits; send it again.",
      { cause: response },
    );
  }
  return failure(codes, response);
}

/** The settlement contract's events in a confirmed transaction, with RPC's event ids. */
export function outcomeEvents(
  response: rpc.Api.GetSuccessfulTransactionResponse,
  txHash: string,
  contractId: string | undefined,
): RtgsEvent[] {
  if (!contractId) return [];
  const events: RtgsEvent[] = [];
  (response.events?.contractEventsXdr ?? []).forEach((opEvents, opIndex) => {
    opEvents.forEach((event, index) => {
      const emitter = contractIdOf(event);
      if (emitter !== contractId) return;
      const body = event.body.v0;
      events.push(
        decodeEvent(
          {
            eventId: eventId(response.ledger, response.applicationOrder, opIndex, index),
            ledger: response.ledger,
            closedAt: Number(response.createdAt),
            txHash,
            contractId: emitter,
          },
          body.topics,
          body.data,
        ),
      );
    });
  });
  return events;
}

export function notConfirmed(txHash: string): RtgsError {
  return new RtgsError("transaction", "Not confirmed", `Transaction ${txHash} was not seen in a closed ledger in time.`);
}

/** Polls until the transaction is in a closed ledger; throws on failure. */
export async function confirm(
  ctx: TxContext,
  txHash: string,
  source: "settlement" | "sac" = "settlement",
): Promise<TxOutcome<xdr.ScVal | undefined>> {
  let response: rpc.Api.GetTransactionResponse;
  try {
    response = await ctx.server.pollTransaction(txHash, { attempts: POLL_ATTEMPTS, sleepStrategy: () => 1000 });
  } catch (e) {
    throw toRtgsError(e);
  }
  if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return {
      txHash,
      ledger: response.ledger,
      closedAt: Number(response.createdAt),
      value: response.returnValue,
      events: outcomeEvents(response, txHash, ctx.contractId),
    };
  }
  if (response.status === rpc.Api.GetTransactionStatus.FAILED) throw failedTransaction(response, ctx.contractId, source);
  throw notConfirmed(txHash);
}

/** Signs with `signer` (refusing another network) and sends; returns the confirmed outcome. */
export async function signAndSend(
  ctx: TxContext,
  signer: Signer,
  tx: Transaction,
  source: "settlement" | "sac" = "settlement",
): Promise<TxOutcome<xdr.ScVal | undefined>> {
  assertSamePassphrase(signer, ctx.net.passphrase);
  const signedXdr = await signer.signTransaction(tx.toXDR(), { networkPassphrase: ctx.net.passphrase });
  const signed = TransactionBuilder.fromXDR(signedXdr, ctx.net.passphrase);
  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await ctx.server.sendTransaction(signed);
  } catch (e) {
    throw toRtgsError(e);
  }
  if (sent.status === "ERROR") {
    throw sent.errorResult ? failure(resultCodes(sent.errorResult), sent) : new RtgsError("transaction", "Refused", "RPC refused the transaction.");
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new RtgsError("transaction", "Network busy", "RPC asked to try again later.");
  }
  return confirm(ctx, sent.hash, source);
}

/**
 * Whether an account exists, read from the ledger. The SDK's `getAccount` reports any failure,
 * a network error included, as "Account not found", so this tells the two apart.
 */
export async function accountExists(ctx: TxContext, address: string): Promise<boolean> {
  const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }));
  try {
    return (await ctx.server.getLedgerEntries(key)).entries.length > 0;
  } catch (e) {
    throw toRtgsError(e);
  }
}

/** Maps a failure to load `source`'s account: missing (fund it), or the RPC failure it was. */
export async function accountLoadError(ctx: TxContext, source: string, e: unknown): Promise<RtgsError> {
  if (!/Account not found/i.test(String(e instanceof Error ? e.message : e))) return toRtgsError(e);
  if (await accountExists(ctx, source)) return toRtgsError(e);
  return new RtgsError("transaction", "No such account", `${source} does not exist on ${ctx.net.label}; fund it first.`, { cause: e });
}

async function builder(ctx: TxContext, source: string): Promise<TransactionBuilder> {
  let account;
  try {
    account = await ctx.server.getAccount(source);
  } catch (e) {
    throw await accountLoadError(ctx, source, e);
  }
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: ctx.net.passphrase }).setTimeout(TIMEOUT_SECS);
}

/** Sends classic operations (trustlines, flags, payments, data entries) from the signer's account. */
export async function sendClassic(ctx: TxContext, signer: Signer, ops: xdr.Operation[]): Promise<TxOutcome> {
  const b = await builder(ctx, signer.address);
  for (const op of ops) b.addOperation(op);
  const outcome = await signAndSend(ctx, signer, b.build());
  return { ...outcome, value: undefined };
}

/**
 * Sends one Soroban operation from the signer's account: simulates (mapping a refusal to an
 * `RtgsError`, with `source` saying whose contract errors to expect), assembles, signs, sends.
 */
export async function sendInvoke(
  ctx: TxContext,
  signer: Signer,
  op: xdr.Operation,
  source: "settlement" | "sac" = "settlement",
): Promise<TxOutcome<xdr.ScVal | undefined>> {
  const b = await builder(ctx, signer.address);
  b.addOperation(op);
  const unsigned = b.build();
  const prepared = await retryTransient(async () => {
    try {
      return await ctx.server.prepareTransaction(unsigned);
    } catch (e) {
      throw toRtgsError(e, source);
    }
  });
  return signAndSend(ctx, signer, prepared, source);
}

/** Simulates one read-only Soroban operation and returns its value. */
export async function simulateRead(ctx: TxContext, op: xdr.Operation, source: "settlement" | "sac" = "settlement"): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(new Account(contract.NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: ctx.net.passphrase })
    .addOperation(op)
    .setTimeout(TIMEOUT_SECS)
    .build();
  const sim = await retryTransient(async () => {
    let result: rpc.Api.SimulateTransactionResponse;
    try {
      result = await ctx.server.simulateTransaction(tx);
    } catch (e) {
      throw toRtgsError(e, source);
    }
    if (rpc.Api.isSimulationError(result)) throw toRtgsError(result.error, source);
    return result;
  });
  if (rpc.Api.isSimulationRestore(sim)) throw toRtgsError("archived", source);
  return sim.result?.retval ?? xdr.ScVal.scvVoid();
}
