// The observer's only door into @rtgs/core. It re-exports the read-only surface the app uses
// and nothing that signs: the observer holds no keys on any network (test/no-signer.test.ts).
export {
  defaultNetwork,
  expiresAt,
  flowMatrix,
  formatAmount,
  loadNetworks,
  mainnetEnabled,
  toRtgsError,
  type Bank,
  type BankView,
  type Capabilities,
  type Config,
  type EntryPoint,
  type Env,
  type FeedEvent,
  type FeedStart,
  type FeedStatus,
  type FlowMatrix,
  type LifecycleStep,
  type NetworkConfig,
  type NetworkId,
  type Payment,
  type PaymentRecord,
  type Priority,
  type RtgsError,
  type RtgsEvent,
  type RtgsEventType,
  type RtgsSession,
  type StoreOptions,
  type SystemSnapshot,
  type TokenEvent,
} from "@rtgs/core";
export { RtgsProvider, useConnection, useLedgerClock, useSession, useSnapshot, useStore } from "@rtgs/core/react";

/** How many events core's store keeps (its `MAX_EVENTS`, which it doesn't export). */
export const STORE_EVENT_LIMIT = 2000;
