# frontend-web

The interactive front end for the RTGS settlement contract in `../backend-soroban/`: three static React apps on one shared package, in a pnpm workspace, plus a headless simulation that keeps the devnet busy.

| Path | Package | Who uses it | Dev URL |
|---|---|---|---|
| `packages/core/` | `@rtgs/core` | every app: networks, contract client, signers, event feed, read models, bank registry, devnet bootstrap ([README](packages/core/README.md)) | n/a |
| `apps/central-bank/` | `@rtgs/central-bank` | the central bank, the **operator** and **settlement agent** ([README](apps/central-bank/README.md)) | http://localhost:5174 |
| `apps/participant/` | `@rtgs/participant` | a bank, a **participant** ([README](apps/participant/README.md)) | http://localhost:5175 |
| `apps/observer/` | `@rtgs/observer` | anyone: a read-only view of the whole system ([README](apps/observer/README.md)) | http://localhost:5176 |
| `apps/simulator/` | `@rtgs/simulator` | a Node CLI that keeps the banks transacting until Ctrl-C, so the apps have live traffic ([README](apps/simulator/README.md)) | n/a |

Every app runs against the **devnet** (a local Stellar quickstart), **testnet**, or **mainnet** (opt-in, never the default). There is no backend: the browser talks to Stellar RPC through `@rtgs/core`, and the apps themselves make no RPC calls.

## Live deployment

The three apps are already deployed and run against the Stellar testnet, with a simulator keeping the banks transacting:

| App | URL |
|---|---|
| Observer | <TODO: https://SITE_HOST>/ |
| Central bank | <TODO: https://SITE_HOST>/central-bank/ |
| Participant, Bank 1 | <TODO: https://SITE_HOST>/participant/?bank=1 |

They open on the testnet, and the network selector switches to the hosted devnet. The testnet contract instances are listed in the [root README](../README.md#contract-instances-testnet), and the hosting setup is in [../deploy/hetzner](../deploy/hetzner/README.md).

| Observer | Participant | Central bank |
|---|---|---|
| ![Observer](../docs/images/observer.png) | ![Participant](../docs/images/participant.png) | ![Central bank](../docs/images/central-bank.png) |
| Timeline, participants, queues, credit | Liquidity, payment orders, intraday credit | Overview, conservation check, settlements and offsets |

## Quick start: the devnet and all three apps

You need:
- **Node 26 or later** and **corepack**. Node 26 no longer bundles corepack; pnpm 11.28.5 is pinned in `package.json`.
- **Docker**, plus `jq` and `curl`, for the devnet scripts.
- `../backend-soroban`, in this same repo. Its devnet scripts start the local network.

```sh
# 1. Install
npm install -g corepack && corepack enable
pnpm install

# 2. Start the local network: one Docker container, RPC on http://localhost:8300/rpc (~20 s)
make -C ../backend-soroban devnet-up

# 3. Deploy the cash token and the settlement contract, and onboard 3 funded banks (~30 s)
pnpm devnet:bootstrap

# 4. Run the three apps side by side
pnpm dev

# 5. Optional, in another terminal: keep the banks transacting until Ctrl-C
pnpm simulate
```

Then open:

| App | URL | What to do there |
|---|---|---|
| Central bank | http://localhost:5174 | System overview, banks and the cash token, credit, keeper actions, setup |
| Participant, Bank 1 | http://localhost:5175/?bank=1 | Deposit, submit payment orders, watch your queues |
| Participant, Bank 2 | http://localhost:5175/?bank=2 | The other side of Bank 1's payments, in a second tab |
| Observer | http://localhost:5176 | Timeline, balances, queues, liquidity flows, payment lifecycles |

**There is nothing to configure.** All three apps derive the same demo keys from the public devnet seed (`rtgs-devnet-demo`). The bootstrap publishes the contract id and the bank registry on the central bank's account, and each app reads them from there when it connects. On the devnet, the central bank app signs as the central bank and the participant app signs as whichever bank "Act as" selects, with no wallet.

Instead of step 3, you can bootstrap from the browser: open the central bank app, go to **Setup → Bootstrap the devnet**. That form also takes the number of banks, the cash per bank, and the contract's `Config` (`queueCap`, `expirySecs`, `repoTermSecs`, `penaltyRateBps`). The default expiry is one day; a short one, say `expirySecs` 60, lets a demo show the keeper expiring payment orders. The `Config` applies only to a new contract, so also tick "Deploy a new contract even if one is live".

To run one app only: `pnpm dev:central-bank`, `pnpm dev:participant` or `pnpm dev:observer`.

### A first demo

1. Put the **observer** on one screen. It follows the contract's events live.
2. In **Bank 1**'s tab, deposit some cash from its trustline into its custody balance, then submit a payment order to Bank 2. It settles at once, and Bank 2's tab shows the incoming settlement.
3. Submit a payment order larger than Bank 1's balance. It queues, and the queue shows what blocks the head. Deposit enough to cover it: the eager closure settles it, and the observer's timeline says which action released it. A queued payment order can also be reprioritised or revoked.
4. In the **central bank** app, the overview shows every bank's balance and queues, the central queue against `queue_cap`, and the conservation check. **Keeper** expires payment orders past their expiry; its auto-keeper does it while the tab stays open.

### Stopping, and after a devnet reset

```sh
make -C ../backend-soroban devnet-down    # removes the container and its ledger
```

The devnet keeps no state across a restart. After `devnet-up` again, run `pnpm devnet:bootstrap` again (or Setup → Bootstrap), then reload the apps. On a devnet that is still running, a rerun of the bootstrap resumes or reuses the deployment and adds no money; `pnpm devnet:bootstrap --fresh` deploys a new contract.

## Workspace commands

Run them from this folder.

| Command | What it does |
|---|---|
| `pnpm dev` | All three apps' dev servers, in parallel (ports 5174, 5175, 5176) |
| `pnpm dev:central-bank` / `dev:participant` / `dev:observer` | One app's dev server |
| `pnpm build` | Static bundles in each `apps/*/dist/` |
| `pnpm preview` | Serves the three built bundles on the same ports |
| `pnpm typecheck` | `tsc` on every package |
| `pnpm test` | Every unit and component test, in every package. No network needed |
| `pnpm test:e2e` | Every end-to-end suite, one after another, against a running devnet (see [Tests](#tests)) |
| `pnpm devnet:bootstrap [--rpc URL] [--banks N] [--seed S] [--fresh] [--wasm PATH]` | Deploy on the devnet from Node, and print the deployment as JSON |
| `pnpm bindings` / `pnpm bindings:check` | Regenerate the contract client from the implementation's Wasm, or report drift (see [Contract bindings](#contract-bindings)) |

For anything else in one package, filter: `pnpm --filter @rtgs/observer <script>`.

## Configuration

The defaults cover the local devnet on port 8300. To change a setting, create `.env` in this folder (it is gitignored). All three apps read it, since each app's Vite `envDir` is the workspace root. `.env.example` lists every variable, and [the core README](packages/core/README.md#env) has the full table. The ones you are most likely to need:

| Variable | Default | Use |
|---|---|---|
| `VITE_RTGS_DEVNET_RPC_URL` | `http://localhost:8300/rpc` | A devnet on another port |
| `VITE_RTGS_DEVNET_SEED` | `rtgs-devnet-demo` | Your own set of demo keys, and so your own deployment |
| `VITE_RTGS_TESTNET_CONTRACT_ID` | none | The settlement contract on testnet |
| `VITE_RTGS_TESTNET_RPC_URL` | `https://soroban-testnet.stellar.org` | Another testnet RPC provider |
| `VITE_RTGS_<NET>_BANKS` | none | Bank names: `G…:Name,G…:Name` |
| `VITE_RTGS_ENABLE_MAINNET`, `VITE_RTGS_MAINNET_RPC_URL` | off, none | List mainnet (both are needed) |
| `VITE_RTGS_DEFAULT_NETWORK` | `devnet` | The network the apps open on. Never mainnet |
| `VITE_RTGS_CAPABILITIES` | none | Override the capability probe, e.g. `expire=available,credit=stub` |

Settings are read when a dev server starts and baked in at build time: restart `pnpm dev`, or rebuild, after editing `.env`.

**Node scripts don't read `.env`.** `pnpm devnet:bootstrap` takes the same settings with an `RTGS_` prefix, or as flags. Keep it in step with the apps, for example:

```sh
pnpm devnet:bootstrap --rpc http://localhost:8400/rpc --seed my-seed
```

with `VITE_RTGS_DEVNET_RPC_URL=http://localhost:8400/rpc` and `VITE_RTGS_DEVNET_SEED=my-seed` in `.env`.

Each app can also change its deployment at runtime, per network, without a rebuild: the central bank's **Setup** page (contract id and RPC URL), the participant's **Deployment settings** panel (RPC URL, contract id, central bank), and the observer's contract field. The observer keeps its whole view in the URL (`?network=&contract=&from=&payment=&tx=&ledger=`), so a link can be shared.

### A devnet on another port

To run a devnet of your own next to someone else's:

```sh
IMPL_NAME=impl-mine IMPL_PORT=8400 make -C ../backend-soroban devnet-up
pnpm devnet:bootstrap --rpc http://localhost:8400/rpc
echo 'VITE_RTGS_DEVNET_RPC_URL=http://localhost:8400/rpc' >> .env
pnpm dev
docker rm -f impl-mine                          # when you're done
```

Remove only your own container. `make devnet-down` also deletes `../backend-soroban/.devnet/`, the stellar-cli identities that every devnet on the machine shares.

## Testnet and mainnet

**A seeded testnet** works like the devnet. With `RTGS_TESTNET_SEED` (or `VITE_RTGS_TESTNET_SEED` in the apps) set, the demo identities derive from that seed and sign with the testnet passphrase, through friendbot as on the devnet:

```sh
RTGS_TESTNET_SEED=$(openssl rand -hex 16)   # keep it: it is the deployment's keys
RTGS_TESTNET_SEED=… pnpm devnet:bootstrap --network testnet
RTGS_TESTNET_SEED=… RTGS_NETWORK=testnet pnpm simulate --rate 0.3
```

Build the apps with `VITE_RTGS_TESTNET_SEED`, `VITE_RTGS_TESTNET_CENTRAL_BANK` (the bootstrap prints it) and `VITE_RTGS_DEFAULT_NETWORK=testnet`, and they act as the demo identities on the testnet too. `../deploy/hetzner` hosts it this way (its README, "Testnet"). Mainnet never takes a seed.

**Without a seed**, the cash token and the settlement contract must already be deployed (with stellar-cli, following `../backend-soroban`). Then:

1. Set `VITE_RTGS_TESTNET_CONTRACT_ID=C…` in `.env`, or paste the id into each app's deployment settings.
2. Select **testnet** in the app. Signing goes through Stellar Wallets Kit (Freighter and the other wallets it supports): **Connect wallet**.
3. In the central bank app, with the central bank's wallet, use **Banks** to register each bank, authorize its trustline, issue it cash, and authorize the settlement contract to hold the cash token. Registered banks appear in every app, because the registry lives on the central bank's account.

The central bank's actions are disabled unless the connected signer is the contract's `central_bank()`; keeper actions work with any signer. The observer never signs, on any network.

`open_repo` mints the repo's cash into the settlement contract, and the mint is authorized in the same transaction by the cash token's SAC admin. So the central bank's account must also be the cash token's issuer, as on the devnet; otherwise every repo is refused with `TokenTransferFailed`. Who holds the SAC admin role is still an open decision in `../backend-soroban` (its README).

**Mainnet** is listed only when `VITE_RTGS_ENABLE_MAINNET=true` and `VITE_RTGS_MAINNET_RPC_URL` are both set. Each app asks you to confirm every time you select it (the central bank and participant apps make you type it), and none starts on it.

## What's implemented, and what isn't

The Wasm committed here (`packages/core/wasm/meta.json` names its implementation commit) implements every entry point, credit and the LSM offset included. Core still probes every entry point when it connects, so against an older deployment whose entry points are `todo!()` stubs, the apps disable those actions and show why.

The queue cap refuses a payment order only if it is still queued after the eager closure, gross settlement and offset alike, and the queue was already full; a payment order that completes an offset is accepted at a full queue. The central bank's Setup accepts a `queueCap` of at most 62, the largest the implementation has checked against Mainnet's per-transaction limits.

Two things need a server, which this project doesn't have:
- **An always-on keeper.** The central bank's auto-keeper runs only while its tab is open.
- **History older than RPC's event retention window**, about 7 days. Older payment orders stay readable through the contract's views; only their event trail is lost.

## Tests

```sh
pnpm typecheck
pnpm test                 # unit and component tests for core and the three apps
```

The end-to-end suites run against a real devnet. Each bootstraps its own deployment from a fresh seed, so they don't touch the demo deployment, and each skips itself with a notice if no devnet answers.

```sh
make -C ../backend-soroban devnet-up
pnpm test:e2e                                         # core, then each app; about 3 minutes
RTGS_DEVNET_RPC=http://localhost:8400/rpc pnpm test:e2e   # a devnet on another port
pnpm --filter @rtgs/participant test:e2e              # one suite
```

What each suite covers is in its package's README.

## Contract bindings

The generated client (`packages/core/src/generated/settlement.ts`) and the settlement Wasm (`packages/core/wasm/settlement.wasm`) are committed, so the apps build without Rust or the implementation repo. The devnet bootstrap deploys that committed Wasm.

When the contract changes:

```sh
pnpm bindings:check       # fails if wasm/ is older than ../backend-soroban's built Wasm
pnpm bindings             # regenerate the client and copy the Wasm (needs stellar-cli 28.1.0)
pnpm bindings --build     # run make build in the implementation first (needs its Rust toolchain)
pnpm typecheck && pnpm test
```

`RTGS_IMPL_DIR` points the script at another backend-soroban checkout instead of `../backend-soroban`. After a regeneration, rerun `pnpm devnet:bootstrap`: a published contract that runs another Wasm is replaced by a new deployment.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| An app can't find the contract on the devnet, or the central bank app opens on Setup | Nothing is deployed on this devnet, usually after a reset. Run `pnpm devnet:bootstrap`, then reload. |
| `network-mismatch` | The RPC URL points at another network than the one selected, for example a testnet URL in `VITE_RTGS_DEVNET_RPC_URL`. |
| The apps find a different deployment from the one the bootstrap printed | The seed or RPC URL differs between `.env` and the bootstrap. Pass the same `--seed` and `--rpc`. |
| `e2e: skipped, no healthy devnet RPC at …` | No devnet on that port. Start one, or set `RTGS_DEVNET_RPC`. |
| A port is already in use | Vite takes the next free port and prints it. To choose one: `pnpm dev:participant --port 5185`. |
| `pnpm` isn't found, or is the wrong version | `npm install -g corepack && corepack enable`, from this folder. |
| `make devnet-up` says the container exists | A devnet with that name is already up: use it, or `make -C ../backend-soroban devnet-down` first. |

## Layout

```
frontend-web/
├── package.json            workspace scripts
├── pnpm-workspace.yaml     packages, and the catalog: one version of each shared dependency
├── .env.example            every VITE_RTGS_* setting
├── tsconfig.base.json      shared compiler options
├── vitest.config.ts        runs every package's tests as Vitest projects
├── packages/core/          @rtgs/core: src/, test/, e2e/, scripts/ (bootstrap, bindings), wasm/
└── apps/
    ├── central-bank/       src/pages/ (Overview, Banks, Credit, Keeper, Setup), e2e/
    ├── participant/        src/ panels by feature, e2e/
    └── observer/           src/model/ (pure), src/components/, test/, e2e/
```

Shared dependency versions live once, in the catalog in `pnpm-workspace.yaml`: a package writes `"react": "catalog:"`. pnpm won't install a release younger than 7 days.

The shared brief and the tickets this was built from are in `../../.scratch/rtgs-frontend/`. The domain terms (participant, operator, settlement agent, payment order, queue, offset, repo) follow `../../GLOSSARY.md`, and the design decisions are in `../../docs/adr/`.
