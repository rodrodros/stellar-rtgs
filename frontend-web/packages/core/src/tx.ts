// Building, signing, sending and confirming transactions. A transaction is final once the
// ledger that applies it closes (ADR-0005), so every send polls until RPC reports it.
import { Account, BASE_FEE, contract, rpc, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import { RtgsError, toRtgsError } from "./errors.ts";
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

/** Polls until the transaction is in a closed ledger; throws on failure. */
export async function confirm(ctx: TxContext, txHash: string): Promise<TxOutcome<xdr.ScVal | undefined>> {
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
  if (response.status === rpc.Api.GetTransactionStatus.FAILED) throw failure(resultCodes(response.resultXdr), response);
  throw new RtgsError("transaction", "Not confirmed", `Transaction ${txHash} was not seen in a closed ledger in time.`);
}

/** Signs with `signer` (refusing another network) and sends; returns the confirmed outcome. */
export async function signAndSend(ctx: TxContext, signer: Signer, tx: Transaction): Promise<TxOutcome<xdr.ScVal | undefined>> {
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
  return confirm(ctx, sent.hash);
}

async function builder(ctx: TxContext, source: string): Promise<TransactionBuilder> {
  let account;
  try {
    account = await ctx.server.getAccount(source);
  } catch (e) {
    const err = toRtgsError(e);
    if (/not found/i.test(String(e))) {
      throw new RtgsError("transaction", "No such account", `${source} does not exist on ${ctx.net.label}; fund it first.`, { cause: e });
    }
    throw err;
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
  let prepared: Transaction;
  try {
    prepared = await ctx.server.prepareTransaction(b.build());
  } catch (e) {
    throw toRtgsError(e, source);
  }
  return signAndSend(ctx, signer, prepared);
}

/** Simulates one read-only Soroban operation and returns its value. */
export async function simulateRead(ctx: TxContext, op: xdr.Operation, source: "settlement" | "sac" = "settlement"): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(new Account(contract.NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: ctx.net.passphrase })
    .addOperation(op)
    .setTimeout(TIMEOUT_SECS)
    .build();
  let sim: rpc.Api.SimulateTransactionResponse;
  try {
    sim = await ctx.server.simulateTransaction(tx);
  } catch (e) {
    throw toRtgsError(e, source);
  }
  if (rpc.Api.isSimulationError(sim)) throw toRtgsError(sim.error, source);
  if (rpc.Api.isSimulationRestore(sim)) throw toRtgsError("archived", source);
  return sim.result?.retval ?? xdr.ScVal.scvVoid();
}
