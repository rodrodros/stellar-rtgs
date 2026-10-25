# @rtgs/core

Everything the three RTGS apps need below their UI: networks, the settlement contract's client, signers, the event feed, read models, the bank registry, the cash token, error messages and the devnet bootstrap. Apps make no RPC calls, decode no XDR and hold no network constants; they import from `@rtgs/core` and `@rtgs/core/react`.

Amounts are `bigint` stroops (7 decimals; `formatAmount` / `parseAmount`), addresses are strkeys, and times are Unix seconds of ledger close time, which is the RTGS's clock.

## Connecting

```ts
import { connect, defaultNetwork, loadNetworks } from "@rtgs/core";

const networks = loadNetworks(import.meta.env);         // devnet, testnet (+ mainnet if enabled)
const session = await connect(defaultNetwork(networks, import.meta.env), { env: import.meta.env });
session.contractId; session.centralBank; session.cashToken; session.capabilities;
```

`connect` does four things:
1. It checks the RPC's passphrase against the network entry (`network-mismatch` otherwise).
2. It finds the contract: the `contractId` option, then config, then (on devnet, or wherever `centralBank` is configured) the central bank's `rtgs.settlement` data entry.
3. It reads the contract's central bank and cash token.
4. It probes capabilities.

Mainnet throws `mainnet-not-acknowledged` unless you pass `acknowledgeMainnet: true`, which should come from the app's confirmation dialog.

A session is immutable. To switch networks, call `session.dispose()` and connect again; `useConnection` does this for React. Every signer is bound to one passphrase and refuses any other, so nothing signs for the wrong network after a switch.

## API

| Area | What | Notes |
|---|---|---|
| Networks | `loadNetworks(env)`, `defaultNetwork`, `withOverrides`, `overridesStore(localStorage, app)` | Env vars below. Runtime overrides per app and network. |
| Reads | `session.read`: `config`, `centralBank`, `queuedCount`, `balance`, `payment`, `queue`, `credit`, `repo`, `bank(addr)`, `latestPaymentId`, `payments({from,to})` | `bank()` = balance + both queues as payment orders + `QueueAnalysis` (head, `covered`, `blockedBy: "uncovered" \| "urgent-queued"`, `expiresAt`, `expired`) + credit when implemented. |
| Writes | `session.as(signer)` → `RtgsActor`: `deposit`, `withdraw`, `submit`, `revoke`, `reprioritise`, `repay`, `setCollateral`, `openRepo`, `expire`, `convertOverdue`, `openTrustline`; `actor.simulate.*` dry runs | Each returns `TxOutcome { txHash, ledger, closedAt, value, events }`. `submit`'s value is `{ id, disposition: "settled" \| "queued" }`. |
| Capabilities | `session.capabilities: Record<EntryPoint, "available" \| "stub" \| "unknown">` | Probed by simulating each entry point: a `todo!()` traps. Overrides: `VITE_RTGS_CAPABILITIES=expire=available,credit=stub`. |
| Signers | `devnetIdentities(net, n)`, `keypairSigner`, `connectWallet(net)` | Devnet keys derive from `VITE_RTGS_DEVNET_SEED`; wallets go through Stellar Wallets Kit (lazy-loaded). |
| Events | `session.events({ from, includeToken, pollMs })` → `EventFeed` | All 12 contract events typed (`RtgsEvent`), cash token events as `TokenEvent`, anything new as `Unknown`. |
| Read model | `session.store()` → `{ store, release }`; `store.getSnapshot()` / `subscribe` | `SystemSnapshot`: config, queued count, banks (views), payment orders with lifecycle steps, repos, collateral, recent events, registry, feed status, ledger clock. |
| Derived | `flowMatrix(events)`, `netFlows`, `analyseQueues`, `expiresAt` | Pure functions. |
| Registry | `session.registry`: `list`, `load`, `nameOf`, `register(cbSigner, {address, name})`, `unregister` | See "Bank registry". |
| Cash token | `session.token.holding(addr)` / `balance`; `session.tokenAdmin(cbSigner)`: `authorize`, `issue`, `clawback`; `CLAWBACK_LIMITS` | `token-admin.ts` is the only code that assumes the central bank is the issuer and SAC admin (spec fact 3). Clawback from the settlement contract is refused (ADR-0006). |
| Errors | `RtgsError { kind, code?, title, detail }`, `toRtgsError(e)` | Contract codes 1–16, SAC errors, classic result codes, RPC, wallet, stubs (`not-implemented`). |
| Devnet | `bootstrapDevnet({ network, wasm, banks, cash, config, onStep })`, `loadSettlementWasm()` | Browser or Node (`pnpm devnet:bootstrap`). |
| React | `useConnection`, `RtgsProvider`, `useSession`, `useStore`, `useSnapshot(selector)`, `useCapabilities`, `useEvents`, `useFeedStatus`, `useBankRegistry`, `useLedgerClock` | From `@rtgs/core/react`. No components. |

### Payment lifecycle

`snapshot.payments.get(id).steps` lists what the feed saw: `submitted`, `reprioritised`, then `settled`, `revoked` or `expired`. A settled step says how the payment settled:
- `via: "at-once"`: on submission.
- `via: "eager-closure"`: released later, with `trigger: { type, actor, paymentId? }` naming the action in the same transaction that released it, for example another bank's `Deposited`.
- `via: "offset"`: in an `Offset`.

A payment order older than the event window has no steps, but its state still comes from the views.

## Env

| Variable | Default |
|---|---|
| `VITE_RTGS_DEVNET_RPC_URL` | `http://localhost:8300/rpc` (friendbot is derived from it, C-HB-073) |
| `VITE_RTGS_DEVNET_SEED` | `rtgs-devnet-demo` (public demo keys; devnet only) |
| `VITE_RTGS_<NET>_CONTRACT_ID` | none: devnet discovers it; testnet and mainnet need it, or `<NET>_CENTRAL_BANK` |
| `VITE_RTGS_<NET>_CENTRAL_BANK` | derived on devnet |
| `VITE_RTGS_<NET>_BANKS` | none. `G…:Name,G…:Name` or JSON `[{ "address", "name" }]` |
| `VITE_RTGS_<NET>_TOKEN_ID` | none. A fallback if the contract's token can't be read |
| `VITE_RTGS_TESTNET_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `VITE_RTGS_ENABLE_MAINNET` | off. `true` lists mainnet |
| `VITE_RTGS_MAINNET_RPC_URL` | none; required for mainnet |
| `VITE_RTGS_DEFAULT_NETWORK` | `devnet` (never mainnet) |
| `VITE_RTGS_CAPABILITIES` | none |

Node scripts read the same names with an `RTGS_` prefix.

## Bank registry

The contract keeps no list of banks (spec fact 2). The registry is the union of four sources:
- the banks listed in config;
- data entries on the central bank's account: `rtgs.bank.<i>` holds an address and `rtgs.bname.<i>` its name, which the central bank app writes with `registry.register`;
- the devnet identities;
- every address the event feed mentions.

The registry excludes the central bank and the contract. The same account also carries `rtgs.settlement`, the contract id, which is how every app finds the current devnet deployment after a reset, with no server and whatever its origin.

## Limits and flags

- **Event retention.** RPC keeps events for its retention window: 120,960 ledgers, about 7 days, by default. `EventFeed` clamps an older start to the oldest retained ledger, and `status()` reports `clamped` and `oldestLedger`. Older history needs an indexer, which this project doesn't have. Payment orders stay readable through the views (`latestPaymentId` + `payments`); only their event trail is lost.
- **No automated keeper.** `expire` and `convertOverdue` run when someone calls them, for example the central bank app. Running them on a schedule needs a server.
- **Contract layout.** The contract has no `token()` view, so `tokenOfContract` reads `DataKey::Token` from its instance storage, with `VITE_RTGS_<NET>_TOKEN_ID` as a fallback. A `next_payment_id()` view would replace the gallop search in `latestPaymentId`.
- **Stub types.** While `credit` and `repo` are stubs, the Wasm's spec doesn't define `Credit` or `Repo`, and 6 of the 12 events aren't in it. The generated client is therefore `@ts-nocheck`. Core owns the domain types and decodes all 12 events from `lib.rs`'s layout. The drift tests fail if a spec event or error no longer matches.
- **Wallet signing** is unit-tested with a fake kit only. Freighter can't be automated here.

## Bindings

```sh
pnpm bindings            # regenerate src/generated/settlement.ts and wasm/ from ../stellar-implementation
pnpm bindings --build    # run make build there first
pnpm bindings:check      # fails if wasm/ doesn't match meta.json, or is older than the implementation's Wasm
```

The script runs `stellar contract bindings typescript`, which stellar-cli 28.1.0 marks deprecated (C-HB-106); the call is in one place in `scripts/bindings.ts`. The generated client and the Wasm are committed, so the apps build without the implementation repo. `$RTGS_IMPL_DIR` overrides where the repo is.

## Tests

```sh
pnpm test                # unit tests, including Wasm drift guards and a Vite browser build
IMPL_NAME=impl-fe-core IMPL_PORT=8350 make -C ../stellar-implementation devnet-up
RTGS_DEVNET_RPC=http://localhost:8350/rpc pnpm test:e2e   # bootstraps a fresh deployment each run
```
