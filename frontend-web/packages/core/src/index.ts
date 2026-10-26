// @rtgs/core: everything the RTGS apps need below their UI. Apps import from here (and from
// "@rtgs/core/react"); they make no RPC calls, decode no XDR and hold no network constants.

// Networks and sessions
export {
  DEFAULT_DEVNET_SEED,
  PASSPHRASES,
  defaultNetwork,
  devnetFriendbotUrl,
  ledgerUrl,
  loadNetworks,
  hasSeed,
  mainnetEnabled,
  overridesStore,
  parseBanks,
  readEnv,
  txUrl,
  withOverrides,
  type BankEntry,
  type Env,
  type NetworkConfig,
  type NetworkId,
  type NetworkOverrides,
} from "./network/networks.ts";
export { connect, RtgsActor, RtgsReader, RtgsSession, type BankView, type ConnectOptions } from "./session.ts";
export { RPC_TIMEOUT_MS, type LedgerClock } from "./rpc.ts";

// Signers
export type { Signer } from "./signer/signer.ts";
export { CENTRAL_BANK_LABEL, bankLabel, deriveDevnetKeypair, devnetBankName, devnetIdentities, keypairSigner, type DevnetIdentities } from "./signer/keypair.ts";
export { connectWallet, disconnectWallet } from "./signer/wallet.ts";

// Contract
export { NO_ID, type Preview } from "./contract/gateway.ts";
export { MAX_CONSERVATION_ACCOUNTS, readConservation, type ConservationRead } from "./contract/conservation.ts";
export { ENTRY_POINTS, allAvailable, parseCapabilityOverrides, type Capabilities, type Capability, type EntryPoint } from "./capabilities.ts";
export type * from "./types.ts";

// Events and read models
export { EVENT_SCHEMAS } from "./events/decode.ts";
export { EventFeed, cursorLedger, type FeedOptions, type FeedStart, type FeedStatus } from "./events/feed.ts";
export { RtgsStore, type LoadProgress, type LoadStep, type StoreOptions, type SystemSnapshot } from "./model/store.ts";
export { applyEvents, emptyState, mergePayments, mergeRepos, type LifecycleStep, type ModelState, type PaymentRecord } from "./model/reducer.ts";
export { analyseQueues, covers, expirablePayments, expiresAt, isExpired, type BankQueues, type QueueAnalysis } from "./model/queues.ts";
export { flowMatrix, netFlows, type FlowMatrix } from "./model/flows.ts";
export { overdueRepos, termEndOf } from "./model/repos.ts";

// Bank registry and the cash token
export { BankRegistry, type Bank, type BankSource } from "./registry/banks.ts";
export { SIM_STATUS_KEY, formatSimStatus, parseSimStatus, type SimStatus } from "./registry/ledger.ts";
export type { CashToken, CashTokenReader, Holding } from "./token/cash-token.ts";
export { CLAWBACK_LIMITS, TokenAdmin } from "./token/token-admin.ts";

// Errors and amounts
export { CONTRACT_ERRORS, RtgsError, toRtgsError, type RtgsErrorKind } from "./errors.ts";
export { CASH_DECIMALS, formatAmount, parseAmount } from "./amount.ts";

// Devnet
export {
  CASH_CODE,
  DEFAULT_CASH,
  DEFAULT_CONFIG,
  bootstrapDevnet,
  type BootstrapOptions,
  type BootstrapStep,
  type BootstrapStepName,
  type Deployment,
} from "./devnet/bootstrap.ts";
export { loadSettlementWasm } from "./devnet/wasm.ts";
