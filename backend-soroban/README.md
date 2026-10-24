# stellar-implementation

The RTGS (real-time gross settlement system) on Stellar, built test first. It implements the formal definition and the ratified decisions of the research foundation:
- **The research foundation:** `../stellar-research/`. Start with its `README.md`.
- **The decisions:** `../docs/adr/`.

**Status, 2026-10-24.** Only the environment exists so far:
- the workspace, with toolchain pins;
- a local devnet with a smoke test;
- CI;
- one contract entry point, `deposit`, with its unit tests.

Payments, queues, offsetting and credit come next, test first.

## Quick start

```sh
make check-env        # every tool matches the handbook's pins
make lint test build  # fmt + clippy, unit tests, Wasm build
make devnet-up        # local quickstart network at protocol 29 on 127.0.0.1:8300
make devnet-smoke     # deploy a test cash token and the contract, deposit, read back
make devnet-down
make cov              # line coverage (informational for now)
```

Prerequisites:
- `make check-env` lists the tools needed and their versions: rustc 1.99.1 with `wasm32v1-none`, stellar-cli 28.1.0 and Docker, plus quint and the cargo plugins for later test layers.
- `rust-toolchain.toml` makes rustup install the right Rust.
- Installing anything else is up to you. Commands and pins are in `../stellar-research/handbook/01-toolchain.md`.

## Layout

| Path | Contents |
|---|---|
| `contracts/settlement/` | The settlement contract: one contract holds the cash token and keeps every bank's balance (ADR-0004). `src/test.rs` holds its unit tests |
| `crates/rtgs-core/` | The pure settlement rules, `no_std` and free of soroban-sdk, so they can be property-tested and proved with Kani. Empty for now |
| `devnet/` | `up.sh`, `smoke.sh` and `down.sh` for the local network. Containers are named `impl-*`, and stellar-cli's identities go in `.devnet/` |
| `scripts/check-env.sh` | The pins check |
| `.github/workflows/ci.yml` | CI, which mirrors `make lint test build`. It has not run on GitHub, because this repo is not pushed |
| `AGENTS.md` | Rules for agents working here |
| `TESTING.md` | How to add each kind of test |
