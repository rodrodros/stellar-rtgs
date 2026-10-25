# @rtgs/central-bank

The central bank's app: the RTGS's **operator** and **settlement agent**. A static React + Vite SPA on `@rtgs/core`; it makes no RPC calls and holds no network constants of its own.

| Page | What the central bank does there |
|---|---|
| Overview | Every bank's settlement balance and queues (urgent first, head first, why a head is blocked, expiry), the central queue against `queue_cap`, recent settlements and offsets, the live `config()`, and a conservation check: the cash the contract holds against the balances it records (S1). |
| Banks | The bank registry (written to the central bank's account), trustline authorization, issuing cash, clawback from a bank's own holding, and the settlement contract's authorization. |
| Credit | `set_collateral`, `open_repo`, the repo list with terms, `repay` on a bank's behalf, `convert_overdue`. |
| Keeper | Expire payment orders past expiry, convert overdue repos; an opt-in auto-keeper while the tab is open. |
| Setup | The devnet bootstrap (core's `bootstrapDevnet`, in the browser), and the contract id and RPC URL per network. |

## Run

```sh
pnpm install
make -C ../../../stellar-implementation devnet-up    # http://localhost:8300/rpc
pnpm --filter @rtgs/central-bank dev                 # then Setup → Bootstrap
```

Settings are core's `VITE_RTGS_*` variables (the workspace's `.env.example`), read from the workspace root. Mainnet is listed only with `VITE_RTGS_ENABLE_MAINNET=true` and a mainnet RPC, and selecting it needs a typed confirmation; the app always starts on the default network, never mainnet.

## Signing

- **Devnet:** the central bank's key is derived in the browser from the devnet seed (core's `devnetIdentities`), and is the default signer.
- **Testnet and mainnet:** a wallet through Stellar Wallets Kit (core's `connectWallet`).

Switching network drops the signer. A signer that isn't the contract's `central_bank()` makes the app read-only. Cash token administration needs the token's admin, which core decides (spec fact 3). Keeper actions work with any signer.

## Safety rails

- **Clawback** is offered only against a bank's own cash token holding, never against the settlement contract (hazard H1, ADR-0006), and core refuses that too. The dialog says what clawback can't do: touch settlement balances, or reverse a final payment.
- **Freezing the settlement contract** (deauthorizing it as a holder) needs `FREEZE` typed: it stops every deposit and withdrawal.
- **Stubs:** every action whose entry point the deployed contract doesn't implement yet is disabled, with the reason shown (core's capability probe).
- **Keeper timing:** "due" follows the contract's guards (strictly after `submitted_at + expiry_secs` and `opened_at + repo_term_secs`), on ledger close time.

## Tests

```sh
pnpm --filter @rtgs/central-bank test         # unit and component tests (jsdom, fake core session)
IMPL_NAME=impl-fe-cb IMPL_PORT=8390 make -C ../../../stellar-implementation devnet-up
RTGS_DEVNET_RPC=http://localhost:8390/rpc pnpm --filter @rtgs/central-bank test:e2e
```

The e2e bootstraps its own deployment from a fresh seed. It then exercises the central bank's role, trustline authorization, issue and clawback (and the refusal against the contract), a queued payment and the conservation check, the capability flags, and the auto-keeper expiring a payment.

## Not built

- **An always-on keeper** needs a server. The auto-keeper here runs only while a tab is open.
- **History beyond the RPC's retention window** (about 7 days) needs an indexer. Repos older than that are visible only once the contract's `repo` view is implemented.
