# stellar-front

Interactive front end for the RTGS settlement contract in `../stellar-implementation/`. A pnpm workspace:

| Path | Contents |
|---|---|
| `packages/core/` | `@rtgs/core`: networks, contract client, signers, event feed, read models |
| `apps/central-bank/` | The central bank's app (operator and settlement agent) |
| `apps/participant/` | A bank's app (participant) |
| `apps/observer/` | A read-only observer of the system |

Every app runs against devnet (the local quickstart), testnet or mainnet (opt-in).

The shared brief and the tickets live in `../.scratch/rtgs-frontend/`.
