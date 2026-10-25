# stellar-front

Interactive front end for the RTGS settlement contract in `../stellar-implementation/`. A pnpm workspace:

| Path | Contents |
|---|---|
| `packages/core/` | `@rtgs/core`: networks, contract client, signers, event feed, read models ([README](packages/core/README.md)) |
| `apps/central-bank/` | The central bank's app (operator and settlement agent) |
| `apps/participant/` | A bank's app (participant) |
| `apps/observer/` | A read-only observer of the system |

Every app runs against devnet (the local quickstart), testnet or mainnet (opt-in).

The shared brief and the tickets live in `../.scratch/rtgs-frontend/`.

## Setup

```sh
corepack enable          # pnpm is pinned in package.json (Node 26 no longer bundles corepack)
pnpm install
pnpm typecheck && pnpm test
```

`.env.example` lists every setting. Shared dependency versions live once, in the catalog in `pnpm-workspace.yaml`: an app writes `"react": "catalog:"`. pnpm won't install a release younger than 7 days.

## Devnet

```sh
make -C ../stellar-implementation devnet-up          # http://localhost:8300/rpc
pnpm devnet:bootstrap                                # cash token, contract, 3 funded banks
```

The bootstrap publishes the contract id and the banks on the central bank's account, so every app finds them with no configuration. The devnet is reset often; run the bootstrap again after a reset. The central bank app can also run the bootstrap in the browser.

## Contract bindings

`pnpm bindings` regenerates the client from `../stellar-implementation`'s Wasm, and `pnpm bindings:check` reports drift. See `packages/core/README.md`.
