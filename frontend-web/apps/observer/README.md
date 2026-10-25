# @rtgs/observer

A read-only watcher of the RTGS: pick a network and a settlement contract, then watch how the participants and the central bank interact. It holds no keys and signs nothing, on any network.

## What it shows

- **Timeline:** every contract event, grouped by transaction, newest first, and filterable by kind of event and by bank. Each settlement says how it came about:
  - settled at once on submission;
  - settled by the eager closure, after the action that released it (a deposit, a revocation, a reprioritisation) or after an earlier settlement in the same cascade credited the sender;
  - settled in an offset.

  Cash token (SAC) events are hidden by default.
- **Participants:** each bank's settlement balance, queue lengths, and why a queue head waits ("needs X more", or held back by the urgent queue). Credit columns appear once the contract implements `credit`.
- **Central queue:** `queued_count` against `queue_cap`, and the live `config()`.
- **Queues:** each bank's urgent and normal queues in queue order. Each shows its head, why the head is blocked, and every payment order's expiry countdown.
- **Liquidity flows:** a payer × payee matrix in three modes: settled in the loaded window, settled net per pair, and queued now.
- **Credit:** repos and collateral once the contract implements them; otherwise a one-line note.
- **Payment lifecycle** (`?payment=<id>`): Submitted → (Reprioritised) → Settled / Revoked / Expired, with each step's ledger, close time and transaction. A queued payment order also shows its place in the queue and its expiry.
- **Transaction** (`?tx=<hash>`) and **ledger** (`?ledger=<n>`): all the events of one transaction, or every loaded transaction of one ledger, with a link to the network's explorer where core configures one (stellar.expert on testnet and mainnet; none on the devnet).
- **Retention window:** what RPC still keeps (about 7 days by default) and where the loaded history starts. You can load from the whole window, the last hour, now, or a ledger number; while older events load, it shows how far it has read. Older history would need an indexer, which this project doesn't have. Balances, queues and payment orders are still read live from the contract.

The whole view is in the URL (`?network=&contract=&from=&payment=&tx=&ledger=`), so it can be shared or put on a demo screen. A link whose network isn't offered, or whose contract id is malformed, is refused rather than shown against another network or contract.

## Running it

```sh
pnpm install
pnpm --filter @rtgs/observer dev        # http://localhost:5176
pnpm --filter @rtgs/observer build      # static bundle in dist/
```

Settings come from `VITE_RTGS_*` env vars (see `../../.env.example` and `packages/core/README.md`). On devnet the contract is found on the central bank's account after a bootstrap. On testnet, set `VITE_RTGS_TESTNET_CONTRACT_ID`, or paste the id into the contract field. Mainnet is listed only with `VITE_RTGS_ENABLE_MAINNET=true` and `VITE_RTGS_MAINNET_RPC_URL`, and you confirm it every time you choose it.

## Tests

```sh
pnpm --filter @rtgs/observer test       # models, components (jsdom, fake session), and the no-signer guard
IMPL_NAME=impl-fe-observer IMPL_PORT=8380 make -C ../stellar-implementation devnet-up
RTGS_DEVNET_RPC=http://localhost:8380/rpc pnpm --filter @rtgs/observer test:e2e
```

The e2e test bootstraps a fresh deployment, drives two scenarios through core's devnet identities, and checks the observer's models against what core's store reads:
- a deposit that releases a two-step cascade;
- a revocation that unblocks a normal queue.

## Layout

| Path | Contents |
|---|---|
| `src/core.ts` | The only module that imports `@rtgs/core`: the read-only surface, no signers |
| `src/model/` | Pure functions: transaction grouping and settlement causes, flows, expiry, retention, URL state |
| `src/state/query.tsx` | The URL query as app state |
| `src/components/` | Panels and drawers; no RPC and no XDR |
| `test/` | Fake session, event builders, component tests, the no-signer guard |
| `e2e/` | Devnet end to end |

## Gaps in @rtgs/core

The observer works around these today; each would be a small addition to core.
- **`MAX_EVENTS`.** The store keeps only the newest 2,000 events. Once it reaches that, the observer warns, and it leaves the oldest kept transaction out of the cause analysis, since it may have lost its first events. The constant isn't exported from the package root, so `src/core.ts` repeats it. Ask: export it.
- **A read-only entry.** `@rtgs/core`'s root entry also brings in the devnet bootstrap, so the observer's bundle carries the settlement Wasm and the SAC spec, which it never uses. Ask: a read-only entry (or side-effect-free modules) that leaves them out.

## Shared UI

`Amount`, `Address`, the queue lanes and the banks table overlap with the central bank's system overview and the participant's own queues. A shared UI package could come later; none is built.
