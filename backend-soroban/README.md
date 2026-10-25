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
- the kernel's greatest feasible prefix, `rtgs_core::greatest_feasible_prefix` (Spec O, R4, ADR-0010): the descent from every candidate, dropping the last candidate of the lowest infeasible account until every account ends non-negative. F1 is decided exactly over the integers, so queued sums beyond `i128` neither panic nor rule a prefix out (SC-A03-11). The contract's offset calls it, with its unit and property tests, and then `rtgs_core::balances_after`, which books each account's net change exactly (SC-A03-12), with its unit tests;
- `submit` (A1): the sender's authorization, `InvalidAmount` and `SameAccount`, sequence-number ids and the payment record. A payment `covers` accepts settles at once (A2); any other waits in the sender's queue for its priority. The `payment`, `queue` and `queued_count` views read them back;
- queue discipline at submission (S7, ADR-0008, ADR-0009): within a priority, payments are strictly first in, first out, and a bank's queued urgent payment blocks its normal ones, so a new payment settles at once only if none of the sender's is queued ahead of it, with its unit and property tests;
- the queue cap (ADR-0010): `submit` refuses with `QueueFull` a payment still queued after the eager closure if accepting it would leave more than `Config::queue_cap` payments queued across all banks, that is, when the queue was already full, and rolls the call back. A payment that settles at once, gross or in an offset, is never refused (decided with the user on 2026-10-25, as in the Quint model), with its unit and property tests;
- the eager closure (S9, ADR-0010): after a deposit, a submission that settles at once, a revocation, a reprioritisation or an expiry, every covered head settles, urgent first, and the cascade follows each bank a settlement credits, all in the same call, with its unit and property tests. The offset then follows, and after a submission that queues it runs alone;
- `revoke` (A6, ADR-0016): the sender alone revokes a queued payment, with no cut-off. An unknown id is refused with `UnknownPayment`, and a payment no longer queued with `NotQueued` (settled, revoked or expired). The payment leaves its queue with status `Revoked`, and the eager closure settles whatever that releases, with its unit and property tests;
- `reprioritise` (A8, ADR-0009): the sender alone moves a queued payment to the other priority, where it keeps its place by age (`toEnd = false`, decided with the user on 2026-10-24). An unknown id is refused with `UnknownPayment`, a payment no longer queued with `NotQueued` (settled, revoked or expired), and a move to the priority it already has with `SamePriority`. The eager closure then settles whatever the move releases, with its unit and property tests;
- `expire` (A5, ADR-0015): anyone, with no authorization, rejects a queued payment once more than `Config::expiry_secs` have passed since its submission (`now > submitted_at + expiry_secs`, without overflow). An unknown id is refused with `UnknownPayment`, a payment no longer queued with `NotQueued`, and one whose expiry has not passed with `NotExpired`. The payment leaves its queue with status `Expired`, and the eager closure settles whatever that releases, with its unit and property tests;
- the LSM offset (A3, Spec O, ADR-0010): once gross settlement is at rest, in the same call, the greatest feasible prefix of every queued bank's payments, urgent first and then by id, settles as one `Offset` event followed by one `Settled` event per payment, in id order. Each bank's net change is booked exactly, so an offset whose sums exceed `i128` still settles (SC-A03-11, SC-A03-12). The model's closure repeats gross settlement and the offset until an offset settles nothing; since k* is exact, the rounds after the first offset settle nothing (R5), so the contract runs one of each. That rests on strict FIFO in both priorities, one floor for gross settlement and the offset alike (today 0), and no limits (K6, ADR-0018, provisional): limits would bring the loop back. The contract keeps one index per priority of the banks with a queued payment, since the offset ranges over every queue. With its unit tests;
- the closure's cost at the queue cap (ADR-0010): with the queue full at 62 payments, one `deposit`, or one covered `submit`, settles all of them within Mainnet's per-transaction limits, whether by offset or by a gross cascade, with one priority or both, and with the banks Stellar accounts, as on the network. Gross settlement and the offset read only the queues that exist, through the indexes. Events bind first: a covered `submit` that makes a full ring feasible publishes 16,256 event bytes, 16,268 with its return value, which Mainnet counts too, of the 16,384 allowed. At a cap of 63 it needs 16,508, and even a deposit that settles a full ring by offset is over by its return value, so the cap under test is 62. The most entries go to a covered `submit` that cascades down a binary tree of 63 banks: 194 of Mainnet's 200 written entries, and 392 of the 400 footprint entries the test host counts, since it counts a written entry twice. A submission that completes an offset over the full queue is accepted too, and uses 16,280 of the 16,384 bytes of events and return value, the tightest margin; at 63 it needed 16,532. A refused one, which now runs the closure before it fails, uses at most 267 entries;
- the model-based replay (TESTING.md §3): the 50 committed Quint traces replay against the contract step by step, with the same outcome, state and settlement events;
- integration scenarios for `deposit` on the devnet (`integration/`).

Credit comes next, test first.

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
| `crates/rtgs-core/` | The pure settlement rules, `no_std` and free of soroban-sdk, so they can be property-tested and proved with Kani. The settlement contract calls its cover rule, and for the offset its greatest feasible prefix and its exact booking of each account's net change |
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
- [x] **Decide what the queue cap does to an offset (ADR-0010).** The queue is full, and a new payment is not covered alone but would settle at once in an offset that includes it. Decided with the user on 2026-10-25: it settles. The cap refuses only a payment still queued after the eager closure, as the Quint model does, since refusing the payment that clears a gridlock at a full queue works against the eager LSM. `submit` queues the payment, runs the closure, and refuses with `QueueFull` only if the payment is still queued and more than `queue_cap` payments are queued, which happens exactly when the queue was already full; the refusal rolls the call back. SC-A01-23 and `qnt::queueCapOffsetTest` pin it, SC-A01-24 the rollback, and SC-ST-10 prices it at the cap. Recorded here and in `submit`'s doc comment, like the other decisions of this kind, rather than as an ADR: it is a consequence of ADR-0010 that the model already wrote down.
- [ ] **Confirm that the queue cap, not a keeper, is the offset's backstop (ADR-0010).** ADR-0010 names a keeper as the backstop for the eager offset. Flow 14 sizes the cap so that the eager closure over a full queue, gross settlement and offset alike, fits the call that triggers it (SC-ST-04 to SC-ST-09), so the contract has no keeper entry point. The margin is small: at 62, a `submit` that completes an offset uses 16,280 of Mainnet's 16,384 bytes of events and return value (SC-ST-10), and a covered `submit` 194 of the 200 written entries (SC-ST-08). The tests mock authorization, so a bank that signs, rather than being the transaction's source account, costs a few more entries, which no test prices yet. Any entry point that runs the closure with more entries or events of its own, such as `open_repo` (Flow 17, with the mint, the repo and the credit), must be priced at the cap when it lands, and the cap lowered if it does not fit.
- [ ] **Decide who holds the cash token's SAC admin role.** In the tests, the central bank's own account is the issuer and so the admin, and it authorizes the mint inside `open_repo`. As admin, that account can also claw back from or deauthorize the settlement contract outside the contract's recorded A16 path, which breaks S1 or freezes the RTGS (review finding H1, ADR-0006). The alternative is an issuance controller contract that holds the admin role. The `Setup` doc comment and SCENARIOS.md (the A12 section) mark the current choice as provisional.
- [ ] **Decide which addresses a payment may credit.** A1's guard asks that sender and receiver are accounts of the system (§4.6, S11), but the contract keeps no list of banks. `submit` accepts any receiver, including the contract itself or the central bank. A payment to the contract credits `Balance(contract)`, which nothing can withdraw. No test or ADR decides this yet.
- [ ] **Add a devnet scenario for `withdraw`.** `integration/` covers only `deposit`. An `integration/withdraw.sh` (TESTING.md §4) would check on the network what the test host can't: that the bank's own signature is the only one `withdraw` needs (SC-A11-12), that a withdrawal to a trustline the issuer has frozen is refused with `TokenTransferFailed` and leaves the balance unchanged (SC-A11-16), the `withdrawn` event, and the TTL of `Balance(B)` after the withdrawal.
- [ ] **Check that every expensive operation always finishes within one transaction.** The eager closure (`eager_closure`), offset included, runs inside the call that triggers it, so if its worst case breaks Mainnet's per-transaction limits, that call fails and reverts. Then a deposit, or a covered submission, could never go through. The work is bounded only by `Config::queue_cap`, since the closure settles only payments already queued. A scratch measurement on 2026-10-25 used a chain of `queue_cap` queued payments that one deposit releases end to end, with the contract registered from Wasm. It fitted up to a cap of 48: 352 of 400 footprint entries, 149 of 200 written entries, 50M instructions and 11.5 KB of events. At 56 the test host refused it, with 408 footprint entries against 400. Each settlement adds about 7 footprint entries and 230 bytes of events. So SC-ST-04's provisional cap of 64 doesn't fit even gross settlement. Two things are needed:
  - a cost test of the worst gross cascade at the cap, next to SC-ST-04, for every entry point that runs the closure (`deposit`, `submit`, `revoke`, `reprioritise` and `expire`);
  - a cap set with room for the rest of the work in the same call: Flow 13's offset and its bank index, which Flow 14 measures (SC-ST-04), and Flow 20's TTL extensions.

  Flow 14 did both for `deposit` and `submit`: SC-ST-04 to SC-ST-09 price the offset and the worst gross cascade at a cap of 62, with account banks. Of those, the worst for events, a covered `submit` that makes a full ring feasible (SC-ST-09), uses 16,268 of 16,384 bytes with its return value; the worst for entries (SC-ST-08) uses 194 of 200 writes and 392 of the test host's 400 footprint entries. `revoke`, `reprioritise` and `expire` release at most one payment fewer than the cap, so they cost less: a scratch measurement in Flow 14's review, at 62 with account banks, put them at 378 to 383 test-host entries, at most 190 writes and at most 15,568 event bytes. They are not yet priced by a test. Flow 15 priced a `submit` that completes an offset at the cap (SC-ST-10: 392 entries, 194 writes, 16,280 bytes with its return value) and one the cap refuses (SC-ST-11: 267 entries); the table is in `unit::storage`.

  If ADR-0007's throughput target needs a higher cap, the closure would have to stop after a fixed number of settlements and leave the rest to the keeper. That breaks S9, which says every queue is at rest after every call, so it needs a decision from the user and a change to ADR-0010.
