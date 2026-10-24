# stellar-implementation

The RTGS (real-time gross settlement system) on Stellar, built test first. It implements the formal definition and the ratified decisions of the research foundation:
- **The research foundation:** `../stellar-research/`. Start with its `README.md`.
- **The decisions:** `../docs/adr/`.

**Status, 2026-10-24.** Only the environment exists so far:
- the workspace, with toolchain pins;
- a local devnet with a smoke test;
- CI;
- one contract entry point, `deposit`, with its unit tests;
- integration scenarios for `deposit` on the devnet (`integration/`).

Payments, queues, offsetting and credit come next, test first.

## Quick start

```sh
make check-env        # every tool matches the handbook's pins
make lint test build  # fmt + clippy, unit tests, Wasm build
make devnet-up        # local quickstart network at protocol 29 on 127.0.0.1:8300
make devnet-smoke     # deploy a test cash token and the contract, deposit, read back
make integration      # every scenario in integration/ (builds first); pending ones are reported
make devnet-down
make cov              # line coverage (informational for now)
make quint            # Quint model: tests, invariants, and a check that quint/traces/ is fresh
```

The devnet targets read `IMPL_NAME` and `IMPL_PORT` (defaults `impl-local`, 8300). To run one network per worktree, give each its own pair, and pass the same values to up, smoke, integration and down: `IMPL_NAME=impl-mine IMPL_PORT=8340 make devnet-up integration devnet-down`.

Prerequisites:
- `make check-env` lists the tools needed and their versions: rustc 1.99.1 with `wasm32v1-none`, stellar-cli 28.1.0 and Docker, plus quint and the cargo plugins for later test layers.
- `rust-toolchain.toml` makes rustup install the right Rust.
- Installing anything else is up to you. Commands and pins are in `../stellar-research/handbook/01-toolchain.md`.

## Layout

| Path | Contents |
|---|---|
| `contracts/settlement/` | The settlement contract: one contract holds the cash token and keeps every bank's balance (ADR-0004). `src/tests/` holds its unit and auth tests, and `tests/SCENARIOS.md` maps each scenario to them |
| `crates/rtgs-core/` | The pure settlement rules, `no_std` and free of soroban-sdk, so they can be property-tested and proved with Kani. Its rules (cover and the greatest feasible prefix) are stubs whose unit tests are red |
| `quint/` | The contract-level Quint model `settlement.qnt`, its tests `settlement_test.qnt`, and the ITF traces in `traces/` that `src/tests/itf_replay.rs` replays against the contract (TESTING.md §3). `make quint-traces` regenerates them |
| `devnet/` | `up.sh`, `smoke.sh` and `down.sh` for the local network. Containers are named `impl-*`, and stellar-cli's identities go in `.devnet/` |
| `integration/` | The devnet scenarios (TESTING.md §4): `lib.sh` holds the ADR-0003 cash-token setup, `run.sh` runs every scenario, and `pending/` holds the scenarios written ahead of the contract code they need |
| `scripts/check-env.sh` | The pins check |
| `.github/workflows/ci.yml` | CI, which mirrors `make lint test build`. It has not run on GitHub, because this repo is not pushed |
| `AGENTS.md` | Rules for agents working here |
| `TESTING.md` | How to add each kind of test |

## To do: decisions to make

Behaviours the ADRs leave open. Each needs a decision from the user, then a test that pins it.

- [ ] **Decide whether an expired payment can still settle.** ADR-0015 says a keeper rejects a payment once its expiry has passed. Until that happens, can the payment still settle if an incoming payment or a deposit covers it? Today no test decides this.
- [x] **The penalty rate is recorded but not charged (ADR-0014).** Decided with the user on 2026-10-24: a penalty repo carries only its status and its rate, and no interest accrues. Conversion mints and burns nothing. This is recorded in the header of `contracts/settlement/src/tests/unit/credit.rs`.
- [ ] **Decide what the queue cap does to an offset (ADR-0010).** The queue is full, and a new payment is not covered alone but would settle at once in an offset that includes it. Is it refused with `QueueFull`, or does it settle? `the_queue_cap_refuses_only_payments_that_would_queue` only tests a payment covered on its own.
- [ ] **Decide who holds the cash token's SAC admin role.** In the tests, the central bank's own account is the issuer and so the admin, and it authorizes the mint inside `open_repo`. As admin, that account can also claw back from or deauthorize the settlement contract outside the contract's recorded A16 path, which breaks S1 or freezes the RTGS (review finding H1, ADR-0006). The alternative is an issuance controller contract that holds the admin role. The `Setup` doc comment and SCENARIOS.md (the A12 section) mark the current choice as provisional.
