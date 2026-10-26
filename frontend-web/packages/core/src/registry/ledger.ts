// The off-chain bank registry and deployment discovery, kept as data entries on the central
// bank's account (spec fact 2: the contract keeps no list of banks). Every app reads them
// through RPC, whatever its origin, with no server:
//
//   rtgs.settlement   the settlement contract's id
//   rtgs.bank.<i>     a bank's G-address
//   rtgs.bname.<i>    its display name
//   rtgs.sim          what the headless simulator is doing, and when it last said so
//
// Keys and values are at most 64 bytes. RPC can't list an account's data entries, so readers
// scan indices in batches of 50 and stop at the first batch with no bank. Registration fills
// the lowest free index, so gaps stay small; but if 50 consecutive indices are unregistered,
// the banks above them are no longer found.
import { Keypair, Operation, StrKey, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { RtgsError, toRtgsError } from "../errors.ts";
import type { BankEntry } from "../network/networks.ts";
import type { Signer } from "../signer/signer.ts";
import { sendClassic, type TxContext } from "../tx.ts";
import type { TxOutcome } from "../types.ts";

export const SETTLEMENT_KEY = "rtgs.settlement";
export const SIM_STATUS_KEY = "rtgs.sim";
export const bankKey = (i: number) => `rtgs.bank.${i}`;
export const nameKey = (i: number) => `rtgs.bname.${i}`;
const BATCH = 50;
const MAX_VALUE_BYTES = 64;

function dataKey(account: string, name: string): xdr.LedgerKey {
  return xdr.LedgerKey.data(
    new xdr.LedgerKeyData({ accountId: Keypair.fromPublicKey(account).xdrAccountId(), dataName: name }),
  );
}

/** Reads data entries of `account`; absent names are missing from the result. */
export async function readData(ctx: TxContext, account: string, names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < names.length; i += 200) {
    let response;
    try {
      response = await ctx.server.getLedgerEntries(...names.slice(i, i + 200).map((n) => dataKey(account, n)));
    } catch (e) {
      throw toRtgsError(e);
    }
    for (const entry of response.entries) {
      if (entry.val.type !== "data") continue;
      const data = entry.val.data;
      found.set(data.dataName.toString(), Buffer.from(data.dataValue.value).toString("utf8"));
    }
  }
  return found;
}

export interface LedgerBank extends BankEntry {
  index: number;
}

/** The banks registered on the central bank's account. */
export async function readLedgerBanks(ctx: TxContext, centralBank: string): Promise<LedgerBank[]> {
  const banks: LedgerBank[] = [];
  for (let start = 0; ; start += BATCH) {
    const indices = Array.from({ length: BATCH }, (_, k) => start + k);
    const data = await readData(ctx, centralBank, indices.flatMap((i) => [bankKey(i), nameKey(i)]));
    let any = false;
    for (const i of indices) {
      const address = data.get(bankKey(i));
      if (!address) continue;
      any = true;
      if (!StrKey.isValidEd25519PublicKey(address)) continue;
      const name = data.get(nameKey(i));
      banks.push(name ? { index: i, address, name } : { index: i, address });
    }
    if (!any) return banks;
  }
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function assertCentralBank(signer: Signer, centralBank: string): void {
  if (signer.address !== centralBank) {
    throw new RtgsError("unauthorized-signer", "Not the central bank", "Only the central bank can change the bank registry.");
  }
}

/** Registers (or renames) a bank; returns its outcome. */
export async function registerBank(
  ctx: TxContext,
  cb: Signer,
  centralBank: string,
  bank: { address: string; name?: string },
): Promise<TxOutcome> {
  assertCentralBank(cb, centralBank);
  if (!StrKey.isValidEd25519PublicKey(bank.address)) {
    throw new RtgsError("config", "Not a bank account", `${bank.address} is not a Stellar account address.`);
  }
  const name = bank.name?.trim();
  if (name && utf8Bytes(name) > MAX_VALUE_BYTES) {
    throw new RtgsError("config", "Name too long", `A bank's name is at most ${MAX_VALUE_BYTES} bytes.`);
  }
  const existing = await readLedgerBanks(ctx, centralBank);
  const same = existing.find((b) => b.address === bank.address);
  const used = new Set(existing.map((b) => b.index));
  let index = same?.index ?? 0;
  if (!same) while (used.has(index)) index++;
  const ops = [Operation.manageData({ name: bankKey(index), value: bank.address })];
  // Deleting a data entry that doesn't exist fails the transaction (op_name_not_found).
  if (name) ops.push(Operation.manageData({ name: nameKey(index), value: name }));
  else if (same?.name) ops.push(Operation.manageData({ name: nameKey(index), value: null }));
  return sendClassic(ctx, cb, ops);
}

export async function unregisterBank(ctx: TxContext, cb: Signer, centralBank: string, address: string): Promise<TxOutcome> {
  assertCentralBank(cb, centralBank);
  const bank = (await readLedgerBanks(ctx, centralBank)).find((b) => b.address === address);
  if (!bank) throw new RtgsError("config", "Not registered", `${address} is not in the bank registry.`);
  const ops = [Operation.manageData({ name: bankKey(bank.index), value: null })];
  if (bank.name) ops.push(Operation.manageData({ name: nameKey(bank.index), value: null }));
  return sendClassic(ctx, cb, ops);
}

/** The settlement contract the central bank published, if any. An RPC failure throws. */
export async function discoverDeployment(ctx: TxContext, centralBank: string): Promise<{ contractId?: string }> {
  const data = await readData(ctx, centralBank, [SETTLEMENT_KEY]);
  const id = data.get(SETTLEMENT_KEY);
  return id && StrKey.isValidContract(id) ? { contractId: id } : {};
}

export function publishDeployment(ctx: TxContext, cb: Signer, contractId: string): Promise<TxOutcome> {
  return sendClassic(ctx, cb, [Operation.manageData({ name: SETTLEMENT_KEY, value: contractId })]);
}

/**
 * What the headless simulator last published. `at` is ledger close time (Unix seconds) at the
 * write: while running it rewrites `running` as a heartbeat, so an old `at` means it died.
 */
export interface SimStatus {
  state: "running" | "stopping" | "stopped";
  at: number;
}

const SIM_STATES: ReadonlySet<string> = new Set(["running", "stopping", "stopped"]);

/** `running:1792971603`, the stored form. */
export function formatSimStatus(status: SimStatus): string {
  return `${status.state}:${status.at}`;
}

/** The stored form back; undefined for anything else. */
export function parseSimStatus(value: string | undefined): SimStatus | undefined {
  const match = value?.match(/^([a-z]+):(\d+)$/);
  if (!match || !SIM_STATES.has(match[1]!)) return undefined;
  return { state: match[1] as SimStatus["state"], at: Number(match[2]) };
}

/** The simulator's status on the central bank's account, if it ever published one. */
export async function readSimStatus(ctx: TxContext, centralBank: string): Promise<SimStatus | undefined> {
  return parseSimStatus((await readData(ctx, centralBank, [SIM_STATUS_KEY])).get(SIM_STATUS_KEY));
}

export function publishSimStatus(ctx: TxContext, cb: Signer, centralBank: string, status: SimStatus): Promise<TxOutcome> {
  if (cb.address !== centralBank) {
    throw new RtgsError("unauthorized-signer", "Not the central bank", "Only the central bank publishes the simulation's status.");
  }
  return sendClassic(ctx, cb, [Operation.manageData({ name: SIM_STATUS_KEY, value: formatSimStatus(status) })]);
}
