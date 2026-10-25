// One-call devnet setup, in the browser (the central bank app's one-click bootstrap) or in
// Node (`pnpm devnet:bootstrap`). It follows stellar-implementation's integration/lib.sh:
//
//   1. fund the central bank and the banks through friendbot;
//   2. the issuer sets AUTH_REQUIRED, AUTH_REVOCABLE and CLAWBACK_ENABLED before any
//      trustline opens (ADR-0003, C-HB-164);
//   3. deploy the SAC of USD:<issuer>;
//   4. each bank opens a trustline, the issuer authorizes it and issues the bank its cash;
//   5. upload the Wasm and deploy the settlement contract with (token, cb, config);
//   6. the SAC admin authorizes the contract to hold the cash token;
//   7. publish the contract id and the bank registry on the central bank's account.
//
// Every step checks what is already there first, so a rerun resumes. The devnet is reset
// often, after which everything is created afresh.
import { Asset, AuthClawbackEnabledFlag, AuthRequiredFlag, AuthRevocableFlag, hash, Operation } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { Client as SettlementClient } from "../generated/settlement.ts";
import { RtgsError, toRtgsError } from "../errors.ts";
import type { NetworkConfig } from "../network/networks.ts";
import { assertNetwork, rpcServer } from "../rpc.ts";
import { devnetIdentities } from "../signer/keypair.ts";
import { sdkSigning, type Signer } from "../signer/signer.ts";
import { CashTokenReader, type CashToken } from "../token/cash-token.ts";
import { issuerFor, TokenAdmin } from "../token/token-admin.ts";
import { sendClassic, sendInvoke, type TxContext } from "../tx.ts";
import type { Config } from "../types.ts";
import { discoverDeployment, publishDeployment, readLedgerBanks, registerBank } from "../registry/ledger.ts";
import { fundAccount } from "./friendbot.ts";

/** integration/lib.sh's CONFIG: 16 queued payments, a one-day expiry and repo term, 5% penalty. */
export const DEFAULT_CONFIG: Config = { queueCap: 16, expirySecs: 86_400, repoTermSecs: 86_400, penaltyRateBps: 500 };
export const CASH_CODE = "USD";
/** 10,000 USD per bank. */
export const DEFAULT_CASH = 100_000_000_000n;

export type BootstrapStepName = "fund" | "issuer-flags" | "sac" | "banks" | "contract" | "authorize-contract" | "publish";

export interface BootstrapStep {
  step: BootstrapStepName;
  status: "start" | "done" | "skipped";
  detail?: string;
}

export interface BootstrapOptions {
  network: NetworkConfig;
  /** The settlement Wasm: `loadSettlementWasm()`. */
  wasm: Uint8Array;
  config?: Config;
  /** How many banks, and the cash each receives (stroops). */
  banks?: number;
  cash?: bigint;
  /** Deploy a new contract even if the central bank already published a live one. */
  fresh?: boolean;
  onStep?: (step: BootstrapStep) => void;
}

export interface Deployment {
  contractId: string;
  sacId: string;
  cashToken: { code: string; issuer: string };
  centralBank: string;
  banks: { label: string; address: string }[];
}

export async function bootstrapDevnet(options: BootstrapOptions): Promise<Deployment> {
  const { network: net, wasm } = options;
  if (net.id !== "devnet") throw new RtgsError("config", "Devnet only", "The bootstrap deploys only on the devnet.");
  if (!net.friendbotUrl) throw new RtgsError("config", "No friendbot", "The devnet needs a friendbot URL.");
  const config = options.config ?? DEFAULT_CONFIG;
  const cash = options.cash ?? DEFAULT_CASH;
  const report = options.onStep ?? (() => {});
  const server = rpcServer(net);
  await assertNetwork(server, net);
  const ctx: TxContext = { server, net };
  const ids = devnetIdentities(net, options.banks ?? 3);
  const cb = ids.centralBank;

  const run = async <T>(step: BootstrapStepName, work: () => Promise<{ value: T; skipped?: boolean; detail?: string }>) => {
    report({ step, status: "start" });
    try {
      const { value, skipped, detail } = await work();
      report({ step, status: skipped ? "skipped" : "done", ...(detail ? { detail } : {}) });
      return value;
    } catch (e) {
      throw toRtgsError(e);
    }
  };

  await run("fund", async () => {
    const funded = await Promise.all([cb, ...ids.banks].map((s) => fundAccount(server, net.friendbotUrl!, s.address)));
    return { value: undefined, skipped: funded.every((f) => !f) };
  });

  // Spec fact 3: the central bank's account issues the cash token.
  const issuer = issuerFor(cb.address);
  const asset = new Asset(CASH_CODE, issuer);
  const token: CashToken = { sacId: asset.contractId(net.passphrase), code: CASH_CODE, issuer, asset };

  await run("issuer-flags", async () => {
    const required = AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag;
    const { flags } = await server.getAccountEntry(issuer);
    if ((flags & required) === required) return { value: undefined, skipped: true };
    await sendClassic(ctx, cb, [Operation.setOptions({ setFlags: required as 1 | 2 | 8 })]);
    return { value: undefined };
  });

  await run("sac", async () => {
    if (await exists(() => server.getContractInstance(token.sacId))) return { value: undefined, skipped: true };
    await sendInvoke(ctx, cb, Operation.createStellarAssetContract({ asset }), "sac");
    return { value: undefined, detail: token.sacId };
  });

  const admin = new TokenAdmin(ctx, cb, token);
  const holdings = new CashTokenReader(ctx, token);

  await run("banks", async () => {
    let changed = false;
    for (const bank of ids.banks) {
      let holding = await holdings.holding(bank.address);
      if (!holding.exists) {
        await sendClassic(ctx, bank, [Operation.changeTrust({ asset })]);
        holding = await holdings.holding(bank.address);
        changed = true;
      }
      if (!holding.authorized) {
        await admin.authorize(bank.address, true);
        changed = true;
      }
      if (holding.balance < cash) {
        await admin.issue(bank.address, cash - holding.balance);
        changed = true;
      }
    }
    return { value: undefined, skipped: !changed };
  });

  const contractId = await run("contract", async () => {
    if (!options.fresh) {
      const { contractId: published } = await discoverDeployment(ctx, cb.address);
      if (published && (await exists(() => server.getContractInstance(published)))) {
        return { value: published, skipped: true, detail: published };
      }
    }
    const id = await deploySettlement(ctx, cb, wasm, token.sacId, config);
    return { value: id, detail: id };
  });

  await run("authorize-contract", async () => {
    if ((await holdings.holding(contractId)).authorized) return { value: undefined, skipped: true };
    await admin.authorize(contractId, true);
    return { value: undefined };
  });

  await run("publish", async () => {
    let changed = false;
    if ((await discoverDeployment(ctx, cb.address)).contractId !== contractId) {
      await publishDeployment(ctx, cb, contractId);
      changed = true;
    }
    const registered = await readLedgerBanks(ctx, cb.address);
    for (const bank of ids.banks) {
      if (registered.some((b) => b.address === bank.address && b.name === bank.label)) continue;
      await registerBank(ctx, cb, cb.address, { address: bank.address, name: bank.label! });
      changed = true;
    }
    return { value: undefined, skipped: !changed };
  });

  return {
    contractId,
    sacId: token.sacId,
    cashToken: { code: token.code, issuer },
    centralBank: cb.address,
    banks: ids.banks.map((b) => ({ label: b.label!, address: b.address })),
  };
}

async function exists(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch {
    return false;
  }
}

/** Uploads the Wasm unless the network has it, then deploys a contract running it. */
export async function deploySettlement(ctx: TxContext, deployer: Signer, wasm: Uint8Array, token: string, config: Config): Promise<string> {
  const wasmHash = hash(Buffer.from(wasm));
  if (!(await exists(() => ctx.server.getContractWasmByHash(wasmHash)))) {
    await sendInvoke(ctx, deployer, Operation.uploadContractWasm({ wasm: Buffer.from(wasm) }));
  }
  const tx = await SettlementClient.deploy(
    {
      token,
      cb: deployer.address,
      config: {
        queue_cap: config.queueCap,
        expiry_secs: BigInt(config.expirySecs),
        repo_term_secs: BigInt(config.repoTermSecs),
        penalty_rate_bps: config.penaltyRateBps,
      },
    },
    {
      wasmHash: Buffer.from(wasmHash).toString("hex"),
      networkPassphrase: ctx.net.passphrase,
      rpcUrl: ctx.net.rpcUrl,
      allowHttp: ctx.net.allowHttp,
      ...sdkSigning(deployer),
    },
  );
  const sent = await tx.signAndSend();
  return (sent.result as SettlementClient).options.contractId;
}
