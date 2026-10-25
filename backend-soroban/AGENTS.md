# Agent instructions

This repo implements an RTGS on Stellar as Soroban contracts, test first. Read `README.md` for the layout and `TESTING.md` before writing any test.

## Rules

- **TDD, always.**
  - **Red:** write the test and watch it fail for the reason you expect.
  - **Green:** write the least code that passes it.
  - **Refactor.**
  - No production code without a failing test first.
  - Commit red and green separately when that makes the history clearer.
- **Name what each test checks.** Every test names the model IDs it checks, in its name or its doc comment:
  - actions A1–A20, invariants S1–S23, liveness L1–L3 and results R*n*, from `../stellar-research/definition/rtgs-definition.md` §4;
  - the ADR it enforces.
- **Before handing work back, run `make lint test build`.** All three must pass.
- **No single-letter names.**
  - Name each binding, closure parameter, const, field and function for what it holds: `setup`, `client`, `prefix`, not `s`, `c`, `k`.
  - Allowed: generic parameters (`T`), lifetimes (`'a`), `_`, and `i j x y z w n`.
  - `make lint` enforces this with `clippy::min_ident_chars`, configured in `Cargo.toml` and `clippy.toml`. A new workspace member needs `[lints] workspace = true`.
- **Networks.**
  - Use only the local devnet (`devnet/`).
  - Never send a transaction to testnet or mainnet.
  - Never push.
- **Toolchain.**
  - Don't change the pins in `rust-toolchain.toml`, `Cargo.toml` or `devnet/common.sh` without updating `scripts/check-env.sh` to match.
  - Don't install with `brew` or `sudo`.
- **Generated test snapshots** (`test_snapshots/`) are gitignored. Don't commit them.
- **Never save task-specific guidance to Claude's memory.** It is shared by every agent in this repo.
- **Issues and specs** live in `../.scratch/<feature>/`. The vocabulary is in `../GLOSSARY.md`, and the decisions are in `../docs/adr/`.

## What to implement against

**The ratified decisions** are ADR-0001 to ADR-0013 in `../docs/adr/`. For the contract, the ones that matter most:

| ADR | What it means here |
|---|---|
| 0003 | The cash token is a classic asset, used through its Stellar Asset Contract. Tests use `register_stellar_asset_contract_v2`. |
| 0004 | One settlement contract holds all the tokens and keeps every bank's balance. Conservation (S1): the token balance the contract holds equals the sum of its internal balances. |
| 0005, 0006 | A payment is final when its ledger closes. Clawback never undoes a final payment. |
| 0008, 0009 | Queues are strictly FIFO within each of two priorities, urgent and normal. A queued payment can be moved between them. |
| 0010 | The LSM settles the greatest feasible prefix, eagerly, in the transaction that makes it feasible. A keeper is the backstop. |
| 0011 | Intraday credit is a collateralised repo: the issuer mints against collateral and burns on repayment. |
| 0013 | The system runs 24/7, with no business day, no value dates and no close. |

**The provisional decisions** are ADR-0014 to ADR-0018. Implement against them, and keep each one a single configuration value or a single function, because ratification may still change them:
- **0014:** each repo has a term; an unpaid repo becomes a penalty-rate repo, still collateralised.
- **0015:** a queued payment expires after a set time.
- **0016:** a payment is revocable until it settles, with no cut-off.
- **0017:** no timed or future-dated orders.
- **0018:** no reservations or limits.

**The model in `../stellar-research/definition/` still has a business day**: A17 `Open`, A18 `Close`, value dates and $\tau_{\mathrm{rc}}$/$\tau_{\mathrm{qc}}$. Where it differs from ADR-0013 to ADR-0016, the ADRs win, and the difference must be written down in the test that meets it.

## Where the research lives

| Need | Read |
|---|---|
| How to develop on Stellar protocol 29: pins, dev loop, gotchas | `../stellar-research/handbook/` (start with its `README.md`) |
| Which Stellar feature serves which RTGS need | `../stellar-research/handbook/09-rtgs-specific.md`, `../stellar-research/stellar/contracts/rtgs-mapping.md` |
| The formal model: state, actions, invariants | `../stellar-research/definition/rtgs-definition.md` §4 |
| The executable Quint model and its configurations | `../stellar-research/definition/model/` (`rtgs.qnt`, `README.md`) |
| A worked contract with every test layer | `../stellar-research/stellar/testing/lab/` |
| Claims cited as C-XX-nnn | `rg -n '^### C-HB-130' ../stellar-research` |
