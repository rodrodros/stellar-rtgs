# stellar-implementation

The RTGS (real-time gross settlement system) on Stellar, built test first. It implements the formal definition and the ratified decisions of the research foundation:
- **The research foundation:** `../stellar-research/`. Start with its `README.md`.
- **The decisions:** `../docs/adr/`.

**Status, 2026-10-25.** What exists so far:
- the workspace, with toolchain pins;
- a local devnet with a smoke test;
- CI;
- the contract's constructor, `deposit` and `withdraw`, with the unit tests that exercise only them, and the `balance`, `config` and `central_bank` views;
- `deposit`'s guards: it refuses an amount of 0 or less with `InvalidAmount`, and reports a transfer the cash token refuses as `TokenTransferFailed`;
- `withdraw`'s guards: it refuses an amount of 0 or less with `InvalidAmount` and one above the balance with `InsufficientFunds`, and reports a transfer the cash token refuses as `TokenTransferFailed`;
- the kernel's cover rule, `rtgs_core::covers`: a payment is covered if paying it leaves the sender's balance non-negative, with its unit and property tests;
- `submit` (A1): the sender's authorization, `InvalidAmount` and `SameAccount`, sequence-number ids and the payment record. A payment `covers` accepts settles at once (A2); any other waits in the sender's queue for its priority. The `payment`, `queue` and `queued_count` views read them back;
- queue discipline at submission (S7, ADR-0008, ADR-0009): within a priority, payments are strictly first in, first out, and a bank's queued urgent payment blocks its normal ones, so a new payment settles at once only if none of the sender's is queued ahead of it, with its unit and property tests;
- the queue cap (ADR-0010): once `Config::queue_cap` payments are queued across all banks, `submit` refuses a payment that would queue with `QueueFull`, and still settles one that would settle at once, with its unit and property tests;
- the eager closure (S9, ADR-0010): after a deposit, a submission that settles at once, or a revocation, every covered head settles, urgent first, and the cascade follows each bank a settlement credits, all in the same call, with its unit and property tests;
- `revoke` (A6, ADR-0016): the sender alone revokes a queued payment, with no cut-off. An unknown id is refused with `UnknownPayment`, and a payment no longer queued with `NotQueued` (so far settled or revoked; expiry comes later). The payment leaves its queue with status `Revoked`, and the eager closure settles whatever that releases, with its unit and property tests;
- integration scenarios for `deposit` on the devnet (`integration/`).

Reprioritisation, expiry, offsetting and credit come next, test first.

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
| `contracts/settlement/` | The settlement contract: one contract holds the cash token and keeps every bank's balance (ADR-0004). `src/tests/` holds its unit, auth, property, state-machine and replay tests, and `tests/SCENARIOS.md` maps each scenario to them |
| `crates/rtgs-core/` | The pure settlement rules, `no_std` and free of soroban-sdk, so they can be property-tested and proved with Kani. The settlement contract calls its cover rule. Its greatest feasible prefix is still a stub whose unit and property tests are red |
| `quint/` | The contract-level Quint model `settlement.qnt`, its tests `settlement_test.qnt`, and the ITF traces in `traces/` that `src/tests/itf_replay.rs` replays against the contract (TESTING.md §3). `make quint-traces` regenerates them |
| `devnet/` | `up.sh`, `smoke.sh` and `down.sh` for the local network. Containers are named `impl-*`, and stellar-cli's identities go in `.devnet/` |
| `integration/` | The devnet scenarios (TESTING.md §4): `lib.sh` holds the ADR-0003 cash-token setup, `run.sh` runs every scenario, and `pending/` holds the scenarios written ahead of the contract code they need |
| `scripts/check-env.sh` | The pins check |
| `.github/workflows/ci.yml` | CI, which mirrors `make lint test build`. It has not run on GitHub, because this repo is not pushed |
| `AGENTS.md` | Rules for agents working here |
| `TESTING.md` | How to add each kind of test |

## To do

Two kinds of item. A behaviour the ADRs leave open needs a decision from the user, then a test that pins it. A test still to write needs only the test.

- [ ] **Decide whether an expired payment can still settle.** ADR-0015 says a keeper rejects a payment once its expiry has passed. Until that happens, can the payment still settle if an incoming payment or a deposit covers it? Until this is decided, `quint/settlement.qnt` and the tests built on it assume it can: the replay (SC-MB-01) and the property tests (SC-P-01, SC-P-02).
- [x] **The penalty rate is recorded but not charged (ADR-0014).** Decided with the user on 2026-10-24: a penalty repo carries only its status and its rate, and no interest accrues. Conversion mints and burns nothing. This is recorded in the header of `contracts/settlement/src/tests/unit/credit.rs`.
- [ ] **Decide what the queue cap does to an offset (ADR-0010).** The queue is full, and a new payment is not covered alone but would settle at once in an offset that includes it. Is it refused with `QueueFull`, or does it settle? The unit tests of the cap (SC-A01-09, SC-A01-18, SC-A01-19) only refuse payments that no offset could settle, and SC-P-11 accepts either answer. Until this is decided, `quint/settlement.qnt` refuses a payment only if it is still queued after the closure, offset included, so it settles such a payment, and the replay (SC-MB-01) assumes it: traces 2, 28, 41 and 43 each settle one by offset. If that stands, Flow 13 must check the cap after the closure. A ready test for either answer: `queue_cap` = 2 and nothing deposited, A and B each queue 500 to C, and C, with no balance and nothing queued, pays A 500, which the offset (1, 0, 1) settles.
- [ ] **Decide who holds the cash token's SAC admin role.** In the tests, the central bank's own account is the issuer and so the admin, and it authorizes the mint inside `open_repo`. As admin, that account can also claw back from or deauthorize the settlement contract outside the contract's recorded A16 path, which breaks S1 or freezes the RTGS (review finding H1, ADR-0006). The alternative is an issuance controller contract that holds the admin role. The `Setup` doc comment and SCENARIOS.md (the A12 section) mark the current choice as provisional.
- [ ] **Decide which addresses a payment may credit.** A1's guard asks that sender and receiver are accounts of the system (§4.6, S11), but the contract keeps no list of banks. `submit` accepts any receiver, including the contract itself or the central bank. A payment to the contract credits `Balance(contract)`, which nothing can withdraw. No test or ADR decides this yet.
- [ ] **Add a devnet scenario for `withdraw`.** `integration/` covers only `deposit`. An `integration/withdraw.sh` (TESTING.md §4) would check on the network what the test host can't: that the bank's own signature is the only one `withdraw` needs (SC-A11-12), that a withdrawal to a trustline the issuer has frozen is refused with `TokenTransferFailed` and leaves the balance unchanged (SC-A11-16), the `withdrawn` event, and the TTL of `Balance(B)` after the withdrawal.
- [ ] **Check that every expensive operation always finishes within one transaction.** The eager closure (`eager_closure`), and later the offset, runs inside the call that triggers it, so if its worst case breaks Mainnet's per-transaction limits, that call fails and reverts. Then a deposit, or a covered submission, could never go through. The work is bounded only by `Config::queue_cap`, since the closure settles only payments already queued. A scratch measurement on 2026-10-25 used a chain of `queue_cap` queued payments that one deposit releases end to end, with the contract registered from Wasm. It fitted up to a cap of 48: 352 of 400 footprint entries, 149 of 200 written entries, 50M instructions and 11.5 KB of events. At 56 the test host refused it, with 408 footprint entries against 400. Each settlement adds about 7 footprint entries and 230 bytes of events. So SC-ST-04's provisional cap of 64 doesn't fit even gross settlement. Two things are needed:
  - a cost test of the worst gross cascade at the cap, next to SC-ST-04, for every entry point that runs the closure (`deposit`, `submit` and `revoke`, and later `reprioritise` and `expire`);
  - a cap set with room for the work later flows add to the same call: Flow 13's offset and its bank index, and Flow 20's TTL extensions.

  If ADR-0007's throughput target needs a higher cap, the closure would have to stop after a fixed number of settlements and leave the rest to the keeper. That breaks S9, which says every queue is at rest after every call, so it needs a decision from the user and a change to ADR-0010.
