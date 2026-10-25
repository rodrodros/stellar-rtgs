# Still to fix

This file lists every unit, auth, kernel, property and replay test, grouped into **execution flows**. A flow is one code path or one rule, and implementing it turns a set of tests green together. The flows are in order: each one needs only what the flows before it built.

**Baseline, 2026-10-24.** There are 132 tests: 9 pass and 123 fail, against the `todo!()` stubs in `contracts/settlement/src/lib.rs` and `crates/rtgs-core/src/lib.rs`, and against `deposit`'s missing guards. To reproduce this, run `make build`, then `cargo test --workspace --locked --no-fail-fast`. Plain `make test` stops at the first crate that fails. The property and state-machine tests came after the baseline and add 17 more: 15 red (11 in Flows 4 and 12, 2 in Flow 13 and 2 in Flow 21) and 2 green in Flow 0, which check the reference rule those tests are judged by.

Test paths follow `tests/SCENARIOS.md`:
- `unit::…` stands for `tests::unit::…`;
- `auth::…` for `tests::auth::…`;
- `itf_replay::…` for `tests::itf_replay::…`, all in the `settlement` crate;
- `core::…` for `rtgs_core::tests::…`, and `core::props::…` for `rtgs_core::props::…`;
- `props::…`, `state_machine::…` and `reference::…` for `tests::props::…`, `tests::state_machine::…` and `tests::reference::…`.

The ID in brackets is the test's row in `tests/SCENARIOS.md`.

## Rules for every flow

- **Red, green, refactor (AGENTS.md).** The tests already exist. First run the flow's tests and check that each one fails for the reason you expect. Then write the least code that passes them, and refactor.
- **Run one flow** with `cargo test -p settlement <test name or module>`, or `cargo test -p rtgs-core` for the kernel flows.
- **Gate.** Run `make lint test build` before handing a flow back. Every test green so far must stay green.
- **TTL.** Extend every entry as you write it (`BUMP_THRESHOLD`, `BUMP_AMOUNT`). Flow 0's storage tests check every entry the contract owns, and Flow 20 runs every entry point.
  - The constructor is the exception. A new instance starts at the network's minimum persistent TTL, about 120 days on Mainnet (C-SC-045), and the first entry point that writes extends it.
  - Extending in the constructor would also turn SC-ST-01 and SC-ST-02 red. The test host constructs at ledger 0, so at their deposit on ledger 1,000 the instance is still above the threshold and is not extended again.
- **When a test goes green,** tick its box. When a flow is done, update the status lines in `tests/SCENARIOS.md` and `README.md`.

## Flow 0: already green (11)

Keep these green.

- [x] `unit::funding::deposit_moves_tokens_into_the_contract_and_credits_the_bank` (SC-A11-01)
- [x] `unit::funding::deposit_of_exactly_the_banks_holding_succeeds_and_deposits_add_up` (SC-A11-02)
- [x] `unit::funding::balance_of_an_unknown_bank_is_zero` (SC-A11-14)
- [x] `auth::deposit_is_authorized_by_the_bank_for_itself_and_the_transfer` (SC-A11-12)
- [x] `auth::deposit_without_the_banks_authorization_fails` (SC-A11-12)
- [x] `unit::storage::a_deposit_extends_the_instance_and_the_balance_to_thirty_days` (SC-ST-01)
- [x] `unit::storage::an_entry_is_extended_again_only_below_the_threshold` (SC-ST-02)
- [x] `itf_replay::quint_traces_decode_and_cover_the_paths_the_replay_checks` (SC-MB-02)
- [x] `itf_replay::settlement_events_match_as_a_set_with_each_offset_before_its_own_settlements` (SC-MB-01, pure helper)
- [x] `reference::checks::the_reference_descent_is_the_greatest_feasible_prefix` (SC-P-09, test helper)
- [x] `reference::checks::the_reference_descent_resolves_r7_and_cascades` (SC-P-09, test helper)

## Flow 1: the constructor records the config and the central bank (1)

Store `config` and `cb` in `__constructor`, and implement the `config()` and `central_bank()` views.

- [x] `unit::funding::the_constructor_records_the_configuration_and_the_central_bank` (SC-A11-13)

## Flow 2: deposit's guards (4)

Refuse `amount <= 0` with `InvalidAmount` before calling the SAC. Move the money with `try_transfer`, and report a refused transfer as `TokenTransferFailed`.

- [x] `unit::funding::deposit_of_zero_or_a_negative_amount_is_refused` (SC-A11-03)
- [x] `unit::funding::deposit_of_one_more_than_the_bank_holds_is_refused` (SC-A11-04)
- [x] `unit::funding::deposit_that_would_overflow_the_contracts_holding_is_refused_by_the_sac` (SC-A11-05)
- [x] `unit::funding::a_deauthorized_bank_cannot_deposit` (SC-A11-15)

After this flow, `integration/pending/deposit-failures.sh` and `integration/pending/deposit-zero.sh` reported `NOW PASSES`, so they moved up into `integration/` (TESTING.md §4).

## Flow 3: withdraw, A11 out of the contract (8)

`withdraw` needs:
- the bank's `require_auth`;
- `InvalidAmount` and `InsufficientFunds`;
- the debit;
- a `try_transfer` out, where a refusal is `TokenTransferFailed`;
- the `Withdrawn` event.

- [x] `unit::funding::withdraw_debits_the_bank_and_pays_the_tokens_out` (SC-A11-06)
- [x] `unit::funding::withdraw_of_exactly_the_balance_leaves_zero_even_at_i128_max` (SC-A11-07)
- [x] `unit::funding::withdraw_of_one_more_than_the_balance_is_refused` (SC-A11-08)
- [x] `unit::funding::withdraw_of_zero_or_a_negative_amount_is_refused` (SC-A11-09)
- [x] `unit::funding::withdraw_by_a_bank_with_no_balance_is_refused` (SC-A11-10)
- [x] `unit::funding::a_withdrawal_to_a_deauthorized_bank_is_refused` (SC-A11-16)
- [x] `auth::withdraw_is_authorized_by_the_bank_alone` (SC-A11-12)
- [x] `auth::withdraw_without_the_banks_authorization_fails` (SC-A11-12)

## Flow 4: the kernel's `covers` (2)

A pure rule in `rtgs-core`, which the contract then calls.

- [x] `core::covers_is_balance_minus_amount_at_least_zero` (SC-A03-10)
- [x] `core::props::covers_is_exactly_balance_at_least_amount` (SC-P-03)

## Flow 5: submit records a payment, then settles it at once or queues it (11)

Build on Flow 4. `submit` needs:
- A1's guards, `InvalidAmount` and `SameAccount`;
- sequence-number ids;
- the `Payment` record;
- one queue per bank and priority;
- the `payment`, `queue` and `queued_count` views;
- the `Submitted` and `Settled` events.

- [x] `unit::payments::a_covered_payment_settles_at_once` (SC-A01-01)
- [x] `unit::payments::a_payment_of_exactly_the_balance_settles` (SC-A01-02)
- [x] `unit::payments::a_payment_of_one_more_than_the_balance_is_queued` (SC-A01-03)
- [x] `unit::payments::a_bank_with_no_balance_can_queue_a_payment` (SC-A01-04)
- [x] `unit::payments::a_zero_or_negative_payment_is_refused` (SC-A01-05)
- [x] `unit::payments::a_payment_to_oneself_is_refused` (SC-A01-06)
- [x] `unit::payments::a_payment_of_i128_max_queues_or_settles_without_overflow` (SC-A01-07)
- [x] `unit::payments::ids_are_increasing_sequence_numbers` (SC-A01-08)
- [x] `auth::submit_is_authorized_by_the_sender_alone` (SC-A01-16)
- [x] `auth::submit_without_the_senders_authorization_fails` (SC-A01-16)
- [x] `auth::the_receiver_cannot_submit_a_payment_from_the_sender` (SC-A01-16)

`submit` settles a covered payment at once whatever is queued ahead of it, until Flow 6. Seven tests of later flows pass with this flow, but stay unticked until their own flow re-checks them: each guards against, or depends on, a behaviour that doesn't exist yet. They are SC-A01-13 and SC-A01-14 (Flow 6, queue discipline), SC-A01-10 (Flow 7, the cap), SC-A02-06 and SC-A02-07 (Flow 8, the closure), and SC-A03-04 and SC-A03-05 (Flow 13, the offset). Each one's line says what to check before ticking it.

## Flow 6: queue discipline at submission (7)

Within a priority, payments are strictly first in, first out. While a bank has an urgent payment queued, none of its normal payments settles (S7; ADR-0008, ADR-0009). So a new payment settles at once only if nothing is queued ahead of it.

- [x] `unit::payments::a_covered_payment_waits_behind_an_uncovered_one_of_the_same_priority` (SC-A01-11)
- [x] `unit::payments::a_queued_urgent_payment_blocks_the_banks_normal_payments` (SC-A01-12)
- [x] `unit::payments::an_urgent_payment_settles_ahead_of_queued_normal_ones` (SC-A01-13). Passed since Flow 5, and still passes with the discipline.
- [x] `unit::payments::one_banks_blocked_queue_does_not_block_another_bank` (SC-A01-14). Passed since Flow 5, and still passes with the discipline, which looks at the sender's queues alone.
- [x] `unit::payments::cpss_box_4_strict_fifo_settles_only_the_first_payment` (SC-A01-15)
- [x] `unit::payments::a_covered_urgent_payment_waits_behind_an_uncovered_urgent_one` (SC-A01-17). Added in Flow 6, since no other test checks FIFO within the urgent priority; it fails if an urgent payment ignores the bank's queued urgent ones.
- [x] `props::submissions_keep_each_banks_queue_in_order` (SC-P-10). Added in Flow 6: SC-P-01 checks S7 too, but only once every entry point exists (Flow 21), so this property runs deposits, withdrawals and submissions alone. Against Flow 5's rule it fails with S7: its shrunk case is a normal payment settling past the bank's queued urgent one, which SC-A01-12 already pins as a unit test.

## Flow 7: the queue cap, ADR-0010 (8)

`QueueFull` refuses only a payment that would stay queued. A covered payment with nothing of its sender's queued ahead of it still settles, and since Flow 15 so does one that an offset settles (SC-A01-23).

- [x] `unit::payments::the_queue_cap_refuses_only_payments_that_would_queue` (SC-A01-09)
- [x] `unit::payments::one_below_the_queue_cap_a_payment_still_queues` (SC-A01-10). This is the boundary partner of SC-A01-09. Passed since Flow 5, and still passes with the cap.
- [x] `unit::payments::at_the_queue_cap_a_covered_payment_blocked_by_the_senders_queue_is_refused` (SC-A01-18). Added in Flow 7, since SC-A01-09's covered payment comes from a bank with nothing queued; it fails if the cap checks cover alone and lets a covered payment queue behind the sender's own past the cap. The sender's queued payments are urgent, and both a normal and an urgent payment are refused, so it also fails if only the same priority's queue counts as ahead.
- [x] `unit::payments::the_queue_cap_counts_every_banks_queue_and_refuses_an_urgent_payment_too` (SC-A01-19). Added in Flow 7, since it is the only cap test where the refused payment's sender has nothing queued and other banks fill the cap; it fails if the cap counts only the sender's queue, or (like SC-A01-18) applies to normal payments only. The refused payment is more than everything queued to its sender, so no offset could settle it, and the cap refuses it under either rule for the offset (Flow 15).
- [x] `unit::payments::at_the_queue_cap_a1s_guards_come_before_queue_full` (SC-A01-20). Added in Flow 7, so that a unit test pins what SC-P-11 checks: it fails if `QueueFull` comes before `InvalidAmount` or `SameAccount`.
- [x] `unit::payments::at_the_queue_cap_a_covered_urgent_payment_settles_past_queued_normal_ones` (SC-A01-21). Added in Flow 7, SC-A01-13's case at the cap: it fails if the cap refuses an urgent payment because its bank has normal ones queued.
- [x] `unit::payments::a_settled_payment_does_not_count_toward_the_queue_cap` (SC-A01-22). Added in Flow 7, since no other cap test settles a payment before the cap is reached; it fails if the cap counts every payment submitted rather than those queued.
- [x] `props::submissions_never_queue_past_the_cap` (SC-P-11). Added in Flow 7: SC-P-01 checks the cap too, but only once every entry point exists (Flow 21), so this property runs deposits, withdrawals and submissions alone, with a cap of 3. At the cap it lets a payment that would not settle by cover either be refused or settle in its own submission, so it stays valid once Flow 13's offset exists. It counts the queued payments from their records, so it also fails if `queued_count` drifts from them, and it fails if `QueueFull` comes before A1's guards. It checks after every call that balances move only by the call's own deposit or withdrawal and the payments it settles (S4), conservation, that no balance goes negative and S7's order, so a payment that settles at the cap must be booked, paid for, and must not overtake its sender's queue. With no cap it fails: its shrunk case is a fourth uncovered payment queued past a cap of 3, which SC-A01-09 already pins. With a cap that checks cover alone it fails too: its shrunk case is a covered payment queued behind its sender's own at the cap, which SC-A01-18 already pins.

One decision was left open here (README): what the cap does to a payment that would settle by offset. `quint/settlement.qnt` refuses a payment only if it is still queued after the closure, offset included, and the replay (SC-MB-01) assumes it: traces 2, 28, 41 and 43 each settle one by offset. Flow 15 decided it with the user: the payment settles (SC-A01-23).

## Flow 8: the eager closure, gross (10)

Build on Flows 3 and 6. After any balance increase, from a deposit or from a settlement that credits a bank, settle every covered head, urgent first. Then follow the cascade through the receivers' queues, all in the same call.

- [x] `unit::payments::a_deposit_that_covers_the_head_settles_it_in_the_same_call` (SC-A02-01)
- [x] `unit::payments::new_liquidity_settles_the_queue_in_order_up_to_the_first_uncovered_payment` (SC-A02-02)
- [x] `unit::payments::new_liquidity_settles_urgent_payments_before_normal_ones` (SC-A02-03)
- [x] `unit::payments::a_settlement_cascades_through_the_receivers_queue` (SC-A02-04)
- [x] `unit::payments::a_submission_that_settles_releases_the_receivers_queue` (SC-A02-05)
- [x] `unit::payments::a_withdrawal_settles_nothing` (SC-A02-06). Passed since Flow 5, and still passes with the closure, which a withdrawal never runs.
- [x] `unit::payments::a_settled_payment_never_changes` (SC-A02-07). Passed since Flow 5, and still passes with the closure.
- [x] `unit::payments::a_cascade_that_returns_to_a_bank_settles_its_next_payment` (SC-A02-08). Added in Flow 8, since SC-A02-04's cascade never comes back to a bank; it fails if the closure visits each bank only once, or keeps the entry of a queue it empties.
- [x] `unit::payments::an_uncovered_urgent_head_blocks_the_normal_queue_in_the_closure` (SC-A02-09). Added in Flow 8, since SC-A02-03's urgent payment is covered and settles; it fails if the closure settles a bank's normal payments past an urgent one it does not cover.
- [x] `props::the_closure_leaves_every_queue_at_rest` (SC-P-12). Added in Flow 8: SC-P-01 checks S9 too, but only once every entry point exists (Flow 21), so this property runs deposits, withdrawals and submissions alone. Until Flow 13 it checked gross rest alone, no bank's head in `≺` covered, so that it stayed valid once the offset came. It fails against each of these closures, and each shrunk case is one a unit test already pins: with no closure, a submission that settles and leaves its receiver's covered head queued (SC-A02-05); with no cascade, a deposit whose settlement leaves the receiver's covered head queued (SC-A02-04); with each bank visited once, a cascade that returns to a bank whose next head it now covers (SC-A02-08); and with no urgent block, a normal payment settled past its bank's uncovered urgent one (SC-A02-09). It reads only the views, which show an empty queue the same whether its entry is removed or kept, so a closure that keeps the entry of a queue it empties is left to SC-A02-08. Since Flow 13's review it also checks, as SC-P-13 to SC-P-15 do, that k* = 0 after every call and that `QueuedBanks` holds exactly the banks with a queued payment, once each (`offset_at_rest`). Under the pinned seed and seeds 1–4 it kills four hand mutants: a deposit that runs gross settlement without the offset (SC-A03-06 also kills it); an offset that never rewrites the index (SC-A03-03 also kills it); and `put_queue` never taking a bank out of the index, and `put_queue` ignoring the bank's other priority, so that a bank joins twice. The `debug_assert!` in `offset` also catches a doubled entry once an offset runs, so SC-A03-05 kills the second one too, but without the assert only this check catches either.

## Flow 9: revoke, A6 (12)

`revoke` needs:
- the sender's authorization;
- `UnknownPayment` and `NotQueued`;
- removal from the payment's queue;
- the `Revoked` event;
- then the closure.

- [x] `unit::queue_management::a_queued_payment_can_be_revoked` (SC-A06-01)
- [x] `unit::queue_management::revocation_has_no_cut_off` (SC-A06-02)
- [x] `unit::queue_management::a_settled_payment_cannot_be_revoked` (SC-A06-03)
- [x] `unit::queue_management::a_revoked_payment_cannot_be_revoked_again` (SC-A06-04)
- [x] `unit::queue_management::revoking_an_unknown_payment_is_refused` (SC-A06-06)
- [x] `unit::queue_management::revoking_the_head_releases_the_payment_behind_it` (SC-A06-07)
- [x] `unit::queue_management::revoking_the_urgent_head_releases_normal_payments` (SC-A06-08)
- [x] `unit::queue_management::revoking_from_the_middle_keeps_the_queue_order` (SC-A06-09)
- [x] `unit::funding::withdraw_may_spend_what_a_queued_payment_would_need` (SC-A11-11)
- [x] `auth::revoke_is_authorized_by_the_sender` (SC-A06-10)
- [x] `auth::only_the_sender_can_revoke` (SC-A06-10)
- [x] `props::revocation_takes_out_only_the_revoked_payment` (SC-P-13). Added in Flow 9: SC-P-01 and SC-P-02 check revocation too, but only once every entry point exists (Flow 21), so this property runs deposits, withdrawals, submissions, time steps and revocations alone. Each bank starts with half its holding deposited. Left to random amounts and ids, a bank rarely has a covered payment queued behind an uncovered head, and a revocation rarely hits that head, so a revocation that skips the closure goes unseen. So some calls are resolved against the state when they run: a pair of submissions from one bank, one over its balance and one at most its balance, which S7 queues behind the first; the revocation of a head, preferring one with a covered payment behind it; and the revocation of any queued payment. Blind ids still reach `UnknownPayment` and `NotQueued`, and time steps reach past the default expiry. The no-closure mutant below fails under each of seeds 1 to 20. It fails against each of these revocations, and each shrunk case is one a unit test already pins: with no closure, a revoked head whose covered successor stays queued (SC-A06-07); with no removal from the queue, or with `queued_count` left as it was, a revoked payment still counted (SC-A06-01); with no `NotQueued` check, a settled payment revoked, which traps in the host (SC-A06-03); removing the head instead of the revoked payment, so that the payment behind the head settles rather than being revoked (SC-A06-09); with a cut-off at the expiry, a payment refused once its expiry has passed (SC-A06-02); and revoking the last payment of the queue as well, a covered successor revoked instead of settled (SC-A06-07).

## Flow 10: reprioritise, A8 (13)

The payment keeps its place by id. `reprioritise` needs:
- the sender's authorization;
- `SamePriority`, `NotQueued` and `UnknownPayment`, checked in the order SC-P-02 expects: `UnknownPayment`, `NotQueued`, `SamePriority`;
- the `Reprioritised` event;
- then the closure.

- [x] `unit::queue_management::a_promoted_payment_keeps_its_place_by_age` (SC-A08-01)
- [x] `unit::queue_management::a_demoted_payment_keeps_its_place_by_age` (SC-A08-02)
- [x] `unit::queue_management::promoting_a_blocked_covered_payment_settles_it` (SC-A08-03)
- [x] `unit::queue_management::demoting_an_uncovered_urgent_payment_releases_older_normal_ones` (SC-A08-04)
- [x] `unit::queue_management::reprioritising_to_the_same_priority_is_refused` (SC-A08-05)
- [x] `unit::queue_management::a_settled_payment_cannot_be_reprioritised` (SC-A08-06)
- [x] `unit::queue_management::reprioritising_an_unknown_payment_is_refused` (SC-A08-07)
- [x] `auth::reprioritise_is_authorized_by_the_sender` (SC-A08-08)
- [x] `auth::only_the_sender_can_reprioritise` (SC-A08-08)
- [x] `unit::queue_management::a_revoked_payment_cannot_be_reprioritised` (SC-A08-09). Added in Flow 10, since SC-A08-06's payment is settled; it fails if the guard refuses only a settled payment, or checks `SamePriority` before `NotQueued`.
- [x] `unit::queue_management::a_promoted_payment_waits_behind_an_older_uncovered_urgent_one` (SC-A08-10). Added in Flow 10, as the A8 counterpart of SC-A01-17; it fails if the moved payment settles because it is covered, past an older uncovered urgent head (S7).
- [x] `unit::queue_management::a_payment_past_its_expiry_can_still_be_reprioritised` (SC-A08-11). Added in Flow 10, as the A8 counterpart of SC-A06-02; it fails if `reprioritise` refuses a payment past its expiry that nobody has expired.
- [x] `props::reprioritisation_moves_only_the_priority` (SC-P-14). Added in Flow 10: SC-P-01 and SC-P-02 check reprioritisation too, but only once every entry point exists (Flow 21), so this property runs deposits, withdrawals, submissions, time steps, revocations and reprioritisations alone. Time steps reach past the default expiry, so that a payment is moved after it. Each bank starts with half its holding deposited. As in SC-P-13, some calls are resolved against the state when they run: a pair of submissions from one bank that queues a covered payment behind an uncovered one; a move to the other priority aimed at a covered normal payment behind its bank's head, which a promotion may settle, or at an uncovered urgent payment ahead of normal ones, which a demotion may release; a move of any queued payment to a random priority, half the time its own; a revocation of any queued payment; and a move of a settled or revoked payment, which a blind id seldom reaches. `make mutate` kills each of these mutants under the pinned seed and seeds 1 to 4 (TESTING.md, "Hand mutants"), and each case is one a unit test already pins: with no closure, a promoted covered payment left queued (SC-A08-03); with no `NotQueued` check, a settled payment moved, which traps in the host (SC-A08-06); with `SamePriority` checked before `NotQueued`, a final payment moved to its own priority (SC-A08-09); with no `SamePriority` check, a move to its own priority accepted (SC-A08-05); with the payment's record not rewritten, its queue and its priority disagree (SC-A08-01); with the moved payment put at the end of its new queue, the queue out of id order (SC-A08-01); with a cut-off at the expiry, a payment refused once its expiry has passed (SC-A08-11); and with a guard that refuses only a settled payment, a revoked payment moved, which traps in the host (SC-A08-09).

## Flow 11: expire, A5 under ADR-0015 (12)

`expire` needs no authorization. While `now <= submitted_at + expiry_secs`, it refuses with `NotExpired`. It also needs `NotQueued`, `UnknownPayment`, the `Expired` event and then the closure. When several guards fail, SC-P-02 expects `UnknownPayment`, then `NotQueued`, then `NotExpired`; SC-P-15 pins it already.

- [x] `unit::queue_management::a_payment_past_its_expiry_can_be_expired` (SC-A05-01)
- [x] `unit::queue_management::a_payment_exactly_at_its_expiry_has_not_expired` (SC-A05-02)
- [x] `unit::queue_management::the_expiry_is_configurable` (SC-A05-03)
- [x] `unit::queue_management::expiring_the_head_releases_the_payment_behind_it` (SC-A05-04)
- [x] `unit::queue_management::each_payment_expires_from_its_own_submission` (SC-A05-05)
- [x] `unit::queue_management::a_settled_payment_cannot_be_expired` (SC-A05-06)
- [x] `unit::queue_management::a_revoked_payment_cannot_be_expired` (SC-A05-07)
- [x] `unit::queue_management::expiring_an_unknown_payment_is_refused` (SC-A05-08)
- [x] `unit::queue_management::an_expired_payment_cannot_be_revoked` (SC-A06-05)
- [x] `auth::expire_needs_no_authorization` (SC-A05-09)
- [x] `unit::queue_management::an_expiry_past_u64_max_never_passes_without_overflow` (SC-A05-10). Added in Flow 11, since `expiry_secs` is a `u64` and no other test sets it near the limit; it fails if `submitted_at + expiry_secs` overflows instead of saturating.
- [x] `props::expiry_takes_out_only_the_expired_payment` (SC-P-15). Added in Flow 11: SC-P-01 and SC-P-02 check expiry too, but only once every entry point exists (Flow 21), so this property runs deposits, withdrawals, submissions, time steps, revocations and expiries alone, with `expiry_secs` set to 100 so that time steps reach it. Each bank starts with half its holding deposited. As in SC-P-13, some calls are resolved against the state when they run: a pair of submissions from one bank that queues a covered payment behind an uncovered one; an expiry aimed at a head past its expiry with a covered payment behind it; one aimed at a payment past its expiry behind its head; a time step to exactly a queued payment's expiry, then its expiry; an expiry aimed at a settled, revoked or expired payment still inside its expiry; an expiry of any queued payment; and a revocation aimed at an expired payment. `make mutate` kills each of these mutants under the pinned seed and seeds 1 to 4 (TESTING.md, "Hand mutants"): with no closure, an expired head whose covered successor stays queued (SC-A05-04); with no `NotQueued` check, a settled payment expired, which traps in the host (SC-A05-06); with `NotExpired` checked before `NotQueued`, a final payment inside its expiry refused with `NotExpired`, which no unit test pins; with the boundary excluded, a payment exactly at its expiry expired (SC-A05-02); with the payment left in its queue, or its status left `Queued`, or `queued_count` left as it was, an expired payment still queued or counted (SC-A05-01); with the head of the queue taken out instead of the expired payment, a payment behind its head expired while the head leaves, which no unit test pins; and with `revoke` refusing only settled and revoked payments, an expired payment revoked, which traps in the host (SC-A06-05).

One decision is still open (README): whether a payment can still settle once its expiry has passed but before anyone has expired it. No unit test decides it, but `quint/settlement.qnt` and the tests built on it assume it can: the replay (SC-MB-01) and the property tests (SC-P-01, SC-P-02).

## Flow 12: the kernel's greatest feasible prefix (20)

A pure rule in `rtgs-core`: k* under Spec O, R4 and F1, with F1 decided over the integers: queued sums can exceed `i128`, and an overflow must not make a prefix infeasible (SC-A03-11). It depends on nothing, so it can be done at any time before Flow 13.

- [x] `core::the_prefix_of_empty_queues_is_zero` (SC-A03-09)
- [x] `core::when_everything_fits_the_prefix_is_every_candidate` (SC-A03-09)
- [x] `core::an_uncovered_first_candidate_blocks_the_whole_queue` (SC-A03-09)
- [x] `core::dropping_one_candidate_can_make_others_infeasible` (SC-A03-09)
- [x] `core::the_prefix_does_not_depend_on_the_account_order` (SC-A03-09)
- [x] `core::r7_cycle_has_prefix_one_one_one` (SC-A03-01)
- [x] `core::the_descent_drops_the_last_candidate_of_a_violating_account` (SC-A03-03)
- [x] `core::the_prefix_never_skips_an_earlier_candidate` (SC-A03-04)
- [x] `core::a_prefix_that_leaves_an_account_negative_is_cut_back_at_the_i128_limit` (SC-A03-07)
- [x] `core::balances_beyond_two_to_the_sixty_four_are_decided_exactly` (SC-A03-11)
- [x] `core::props::the_prefix_is_within_every_queue` (SC-P-04)
- [x] `core::props::the_prefix_is_feasible` (SC-P-04)
- [x] `core::props::the_prefix_is_the_greatest_feasible_one` (SC-P-04)
- [x] `core::props::the_prefix_does_not_depend_on_the_account_order` (SC-P-05)
- [x] `core::props::more_liquidity_never_shrinks_the_prefix` (SC-P-05)
- [x] `core::props::gross_processing_never_beats_the_offset` (SC-P-06)
- [x] `core::props::after_the_offset_nothing_more_is_feasible` (SC-P-06)
- [x] `core::props::a_candidate_no_inflow_can_cover_blocks_its_queue` (SC-P-07)
- [x] `core::props::sums_beyond_i128_are_decided_exactly_not_a_panic` (SC-P-08)
- [x] `core::props::at_the_i128_limit_sums_are_decided_exactly` (SC-A03-11)

## Flow 13: the LSM offset in the contract, A3 eager (23)

Build on Flows 8 and 12. Once gross settlement is at rest:
1. Build each bank's candidates in `≺` order: urgent first, then by id.
2. Apply k*, booking each bank's net change exactly: payment by payment, or every debit first, overflows at the `i128` limit (SC-A03-11, SC-A03-12).
3. Publish the `Offset` event, then one `Settled` event for each payment in it.
4. Run the closure again.

Before this flow, ask the user to settle the README decision on the queue cap and the offset. `quint/settlement.qnt` settles a payment that the offset settles, even at the cap. If that stands, first add a unit test, red against Flow 7's check before the closure: at the cap, an uncovered payment that the offset settles is accepted and settles (the README item has one). Then move `submit`'s cap check after the closure, so that it refuses only a payment still queued once the closure is done. If the user chooses to refuse, change `quint/settlement.qnt` and regenerate its traces instead, and add the README's test asserting `QueueFull`: it passes against Flow 7's check, so confirm it goes red against a check moved after the closure. Either way, then narrow SC-P-11's branch at the cap to the chosen answer: with `reference::greatest_feasible_prefix` over the queues plus the new payment, require `Ok(id)` and `Settled` when the prefix takes it and `QueueFull` when it does not ("settle"), or `QueueFull` whenever cover alone does not settle it ("refuse"). Update its doc comment, SCENARIOS row and StillToFix line. SC-P-11 must stay green with the offset: its S4 check sums exactly, so payments of `i128::MAX` settled by offset do not overflow it.

Step 1 needs every bank with a queued payment. Since Flow 5, queues are stored one per `Queue(bank, priority)` and the contract keeps no list of banks, so the offset needs a persistent index of the banks with queued payments. That index could replace `QueuedCount`.

Done in Flow 13 as `QueuedBanks`, a list kept by `put_queue` (the offset rewrites it at most once, when some bank has no payment left; Flow 14 split it into one list per priority), next to `QueuedCount`, which the cap still reads. Step 2 is the kernel's `balances_after`, which sums each account's net change in 64-bit halves, as k* does. Step 4 is not a loop. The model's closure repeats gross settlement and the offset until an offset settles nothing, but since k* decides F1 exactly, R5 makes every round after the first offset empty, and no test can tell the loop from a single offset. So the closure is one gross pass, then one offset. That saves a second read of every queue on the cap path Flow 14 measures. SC-P-12 to SC-P-15 check k* = 0 after every call, so a closure that stopped short of rest would fail them. R5 rests on strict FIFO in both priorities (ADR-0008, ADR-0009), one floor for `covers` and F1 alike (today 0, ADR-0011) and no limits or reservations, so that K6 holds (ADR-0018, provisional). If limits or a class that bypasses FIFO come in, the model's loop must come back (C-DF-026).

The cap decision above was not taken in Flow 13: `submit` still checked the cap before the closure, so it refused a payment that an offset would settle, and SC-P-11 accepts either answer. Flow 15 took it (SC-A01-23).

- [x] `unit::lsm::r7_gridlock_is_resolved_in_the_submission_that_makes_it_feasible` (SC-A03-01)
- [x] `unit::lsm::two_opposite_payments_offset_with_no_liquidity` (SC-A03-02)
- [x] `unit::lsm::the_offset_settles_the_greatest_feasible_prefix_and_leaves_the_rest` (SC-A03-03)
- [x] `unit::lsm::the_offset_never_overtakes_an_older_payment` (SC-A03-04). Passed since Flow 5, and still passes with the offset.
- [x] `unit::lsm::the_offset_takes_a_banks_urgent_payments_before_its_normal_ones` (SC-A03-05). Passed since Flow 5, and still passes with the offset.
- [x] `unit::lsm::a_deposit_can_make_an_offset_feasible` (SC-A03-06)
- [x] `unit::lsm::at_the_i128_limit_the_offset_cuts_back_the_prefix_that_would_leave_a_bank_negative` (SC-A03-07)
- [x] `unit::lsm::after_an_offset_the_queues_are_at_rest` (SC-A03-08)
- [x] `unit::lsm::an_offset_whose_sums_exceed_i128_still_settles` (SC-A03-11)
- [x] `unit::lsm::an_offset_books_each_banks_net_change_exactly` (SC-A03-12)
- [x] `core::the_balances_after_an_offset_book_each_net_change_exactly` (SC-A03-12). Added in Flow 13, for the kernel's `balances_after`.
- [x] `core::the_balances_after_an_offset_move_only_the_prefix` (SC-A03-12). Added in Flow 13: it fails if `balances_after` books candidates past the prefix.
- [x] `core::the_balances_after_an_offset_reach_i128_max_without_overflow` (SC-A03-12). Added in Flow 13's review: it fails if `balances_after` scales the high half before carrying the low half's borrow, which overflows when a bank ends at `i128::MAX`.
- [x] `unit::lsm::revoking_a_blocking_payment_makes_an_offset_feasible` (SC-A03-13). Added in Flow 13, since every other offset test is triggered by a submission or a deposit; it fails if revocation runs gross settlement without the offset.
- [x] `unit::lsm::a_bank_whose_only_payment_changes_priority_still_offsets` (SC-A03-14). Added in Flow 13, for the index of banks with a queue; it fails if a bank drops out of the index when its only payment moves to the other priority.
- [x] `unit::lsm::gross_settlement_comes_to_rest_before_the_offset` (SC-A03-15). Added in Flow 13, since no other offset test settles gross and by offset in the same call; it fails if the offset runs before gross settlement is at rest.
- [x] `unit::lsm::an_offset_lists_its_payments_in_id_order` (SC-A03-16). Added in Flow 13, since in the other offset tests the candidate order is already the id order; it fails if the events follow the candidates.
- [x] `unit::lsm::expiring_a_blocking_payment_makes_an_offset_feasible` (SC-A03-17). Added in Flow 13, the A5 counterpart of SC-A03-13; it fails if expiry runs gross settlement without the offset.
- [x] `unit::lsm::demoting_an_urgent_payment_makes_an_offset_feasible` (SC-A03-18). Added in Flow 13, the A8 counterpart of SC-A03-13; it fails if reprioritisation runs gross settlement without the offset.
- [x] `unit::lsm::an_offset_takes_every_payment_of_a_queue_up_to_the_cap` (SC-A03-19). Added in Flow 13's second review, since no other offset gives a bank more than two candidates: it fails if the offset looks at only a window of each queue, which SC-P-12 to SC-P-15 rarely catch under the pinned seed.
- [x] `unit::lsm::an_offset_credits_a_bank_that_only_receives` (SC-A03-20). Added in Flow 13's second review, since in every other offset each account also sends: it fails if the offset books only the queued banks.
- [x] `unit::lsm::an_offset_credits_a_queued_bank_whose_own_prefix_is_zero` (SC-A03-20). Added in Flow 13's third review, since SC-A03-20's first test credits only a bank with no queue: it fails if the offset books only the banks it takes payments from, and those with no queue.
- [x] `unit::lsm::an_offset_that_ends_inside_a_mixed_queue_takes_the_urgent_payments_first` (SC-A03-21). Added in Flow 13's third review, since in every other offset a bank with both priorities queued has nothing or everything taken: it fails if the offset slices the normal queue first, which leaves the settled urgent payment queued, to settle a second time.

## Flow 14: the offset's cost at the queue cap (8)

These tests register the contract from its Wasm, so run `make build` first. If a call that clears a full queue doesn't fit Mainnet's per-transaction limits, lower `QUEUE_CAP_UNDER_TEST` and record why.

Flow 13's fixture netted to zero for 62 of its 64 banks, and the offset doesn't rewrite a balance that nets to what it was, so it was no longer the worst case for writes. Flow 14 made it the worst case again: a ring of 64 where bank `i` pays `100 − i` and bank 0 deposits 63, so every balance changes. Red: 462 footprint entries, over the test host's 400 (it counts a written entry twice, once read and once written).

The footprint was shrunk first:
- `QueuedBanks` became one index per priority, `QueuedBanks(Priority)`, and the offset reads `Queue(bank, priority)` only for the banks in that priority's index. It used to read `Queue(bank, Urgent)` for every queued bank.
- `put_queue` takes whether the queue was empty, which every caller has read, instead of checking both of the bank's queue keys with `has`.
- Gross settlement reads the two indexes once and skips a queue whose bank is not in its index. Without this, every bank the closure visited cost a read of its absent urgent queue: 463 entries for a gross cascade around the ring (SC-ST-05, red first).

The closure at the cap must fit gross settlement as well as the offset, and both priorities as well as one, so Flow 14 added SC-ST-05 to SC-ST-07, and SC-A03-22 to pin the index (nothing else failed if a payment queued behind another added its bank again). A call that clears a full queue writes, for each payment, the payment and at most one queue and one balance, plus one balance more for a cascade with no cycle. At 64 that cascade touches 65 accounts: the path (SC-ST-05) measured 401 entries and the binary tree with both priorities (SC-ST-07) 402. So `QUEUE_CAP_UNDER_TEST` was lowered to 63.

The review then found that a covered `submit` costs more than any deposit. The cap refuses only a payment that would queue, so `submit` accepts a covered one with the queue full, settles it, and runs the closure: 64 payments across 65 accounts at a cap of 63. SC-ST-08 prices that call cascading down SC-ST-07's tree, and SC-ST-09 the same call making SC-ST-04's ring feasible, which publishes the most events. Each cost test now also holds its call to what it measured, its budget of footprint entries and event bytes, so a needless entry or a larger event fails at once. SC-ST-05 and SC-ST-07 check that the call publishes no `Offset` event, and SC-ST-04, SC-ST-06 and SC-ST-09 exactly one. Without that, SC-ST-05 still passed when gross settlement stopped at the first bank outside an index, because the offset then settled the path.

The third review found that the cost tests' banks were contract addresses, from `Address::generate`. On the network a bank is a Stellar account holding the token on a trustline (ADR-0003), and in XDR an account address is 4 bytes longer, so every `Settled` event, which names two banks, was understated by 8 bytes. `Setup::from_wasm` now makes each bank an account and opens its trustline through the SAC's `trust`. Red: SC-ST-09 at 63 needed 16,508 of Mainnet's 16,384 event bytes. So `QUEUE_CAP_UNDER_TEST` was lowered to 62, and events, not entries, set it. The same review added SC-A03-23: nothing failed if gross settlement, writing a queue it shortened, added the bank to the index again.

Three limits come close, and they count differently. Mainnet allows 16,384 bytes of events and return value, 200 written entries, and 400 footprint entries counted once each. The test host leaves the return value out of the events, so the cost tests add it (4 bytes for a deposit, 12 for a submission's id), and it counts a written entry twice towards the 400. Measured at 62 with account banks, as test-host footprint entries, writes and event bytes: SC-ST-04 387, 191 and 16,132; SC-ST-05 389, 192 and 15,284; SC-ST-06 388, 192 and 16,132; SC-ST-07 390, 193 and 15,284; SC-ST-08 392, 194 and 15,408; SC-ST-09 389, 192 and 16,256, or 16,268 with its return value. At 63, SC-ST-04 and SC-ST-06 publish 16,384 event bytes, which their return value takes over Mainnet's limit. No call uses more than about 84M instructions. The tests mock authorization, so a bank that signs, rather than being the transaction's source account, costs a few entries more that no test prices. Before the account banks, at 63: the submission that queued the 63rd payment, across 63 banks with k* = 0, read 198 entries (263 before Flow 14) and used about 26M instructions (33M before).

`revoke`, `reprioritise` and `expire` release at most one payment fewer than the cap, behind the one they remove. A scratch measurement in the review, at 62 with account banks, put them at 378 to 383 test-host entries, at most 190 writes and at most 15,568 event bytes, below SC-ST-08 and SC-ST-09, but no test prices them yet.

The backstop, decided in Flow 14: the cap is sized so that the eager closure over a full queue fits the call that triggers it, so the contract has no keeper entry point. The README asks the user to confirm this, since ADR-0010 names a keeper. Any later entry point that runs the closure with more entries or events of its own, such as `open_repo` (Flow 17), must be priced at the cap.

- [x] `unit::storage::an_offset_over_a_full_queue_fits_in_one_transaction` (SC-ST-04)
- [x] `unit::storage::a_gross_cascade_over_a_full_queue_fits_in_one_transaction` (SC-ST-05). Added in Flow 14; it fails if gross settlement reads queues that do not exist, or if the cap leaves no room for a cascade's extra account.
- [x] `unit::storage::an_offset_over_a_full_queue_of_both_priorities_fits_in_one_transaction` (SC-ST-06). Added in Flow 14, the offset with both indexes written.
- [x] `unit::storage::a_gross_cascade_down_a_tree_of_both_priorities_fits_in_one_transaction` (SC-ST-07). Added in Flow 14, the worst case for a deposit.
- [x] `unit::storage::a_covered_submission_cascading_down_a_full_tree_fits_in_one_transaction` (SC-ST-08). Added in Flow 14's review, the worst case for entries.
- [x] `unit::storage::a_covered_submission_that_makes_a_full_ring_feasible_fits_in_one_transaction` (SC-ST-09). Added in Flow 14's review, the worst case for events.
- [x] `unit::lsm::a_bank_is_in_the_index_once_per_priority_however_many_payments_it_queues` (SC-A03-22). Added in Flow 14; it fails if a payment queued behind another, or moved into a queue that already holds one, adds its bank to the index again.
- [x] `unit::lsm::gross_settlement_keeps_a_bank_in_the_index_once_until_its_queue_empties` (SC-A03-23). Added in Flow 14's third review; it fails if gross settlement adds a bank to the index again when it shortens the bank's queue.

## Flow 15: the model-based replay (5)

The 50 committed Quint traces call deposit, withdraw, submit, revoke, reprioritise, expire and tick. The replay needs Flows 1 to 13.

After Flow 13, the replay gets through the first traces and stops at `trace2.itf.json` state 27: the model accepts a submission that the contract refuses with `QueueFull`. The model refuses only a payment still queued after the closure, offset included, while the contract refuses before it. That was the README's open decision on the cap and the offset, and it was the only thing in the way: with the model's rule, every trace replays.

Decided with the user on 2026-10-25: follow the model. `submit` queues the payment, runs the eager closure, and refuses with `QueueFull` only if the payment is still queued and more than `queue_cap` payments are queued (`over_the_cap`). The refusal rolls the whole call back. The decision is recorded in the README and in `submit`'s doc comment, like the other decisions taken with the user, not as an ADR. `qnt::queueCapOffsetTest` pins it in the model.

A submission that completes an offset at a full queue is now accepted, so it settles one payment more than the cap by offset. Flow 14's review already priced a covered submission at the cap (SC-ST-08, SC-ST-09), so Flow 15 priced this one (SC-ST-10), and a refused submission, which now runs the closure before it fails (SC-ST-11). At 63, SC-ST-10 used 397 test-host footprint entries and 16,000 of the 16,384 event bytes, the most events of any call at the cap.

Flow 14's third and fourth reviews then made the cost tests' banks Stellar accounts, counted the return value with the events and lowered the cap to 62 (see Flow 14). At 63 SC-ST-10 needs 16,532 bytes of events and return value. At 62 it uses 392 test-host entries and 194 writes, which ties SC-ST-08 for the least room in the footprint, and 16,280 bytes, 104 short of the limit and less than one `Settled` event, the least room in events of any call at the cap. Flow 15's review found that SC-ST-11's ring was not the worst refusal: the offset reads both accounts of every queued payment, so SC-ST-11 now has a distinct sender and receiver for each, and measures 267 entries, 6 writes and about 38M instructions. It also found that nothing failed if the events were priced too low, with contract banks or no return value: each cost test now holds its event bytes exactly (`Budget`), and SC-ST-10's ring alternates priorities, which writes both indexes. The table is in `unit::storage`.

- [x] `itf_replay::quint_traces_replay_against_the_contract` (SC-MB-01)
- [x] `unit::payments::at_the_queue_cap_a_payment_that_completes_an_offset_settles` (SC-A01-23). Added in Flow 15; it fails if the cap is checked before the closure.
- [x] `unit::payments::a_payment_refused_at_the_queue_cap_leaves_no_trace` (SC-A01-24). Added in Flow 15, since `submit` now refuses after writing. It passed before the change, when the refusal came first, and guards the rollback: it fails if a refused payment keeps its id, its record or its place in a queue.
- [x] `unit::storage::a_submission_that_completes_an_offset_over_a_full_queue_fits_in_one_transaction` (SC-ST-10). Added in Flow 15; red first, since the closing payment was refused with `QueueFull`.
- [x] `unit::storage::a_submission_refused_at_the_cap_fits_in_one_transaction` (SC-ST-11). Added in Flow 15, since a refused submission now pays for the closure; it passed before the change, when the refusal came first, and fails if a refusal at the cap goes over Mainnet's limits instead of returning `QueueFull`.

## Flow 16: collateral, A14 (5)

Implement the `credit()` view, and `set_collateral` with:
- the central bank's authorization;
- `InvalidAmount`;
- the `CollateralSet` event;
- the extension of the instance and of the bank's `Credit` entry.

Each bank's credit position is its own persistent entry, `Credit(bank)`, as its balance is.

- [x] `unit::credit::the_central_bank_sets_a_banks_collateral` (SC-A14-01)
- [x] `unit::credit::collateral_can_be_zero_but_not_negative` (SC-A14-02)
- [x] `auth::set_collateral_is_authorized_by_the_central_bank` (SC-A14-04)
- [x] `auth::only_the_central_bank_can_set_collateral` (SC-A14-04). It also pins the order: authorization before the guard `x ≥ 0`.
- [x] `unit::storage::setting_collateral_extends_the_instance_and_the_credit_to_thirty_days` (SC-ST-12). Added in Flow 16, red first: `set_collateral` did not extend the instance. Flow 20's test can't catch that, since its first call is a deposit, which extends the instance in the same ledger. It also checks that the contract owns exactly the instance and one persistent `Credit(bank)` entry, so credit kept in the instance or in temporary storage fails.

## Flow 17: open a repo, A12 with a mint (13)

`open_repo` needs:
- the central bank's authorization, with the SAC `mint` into the contract in the same tree;
- `InvalidAmount`;
- `CreditExceedsCollateral`, checked without overflow;
- the `Repo` record and the `repo()` view;
- the `RepoOpened` event;
- then the closure.

`set_collateral` also gains its `CollateralBelowCredit` check. SC-A14-03 also forces `set_collateral` to keep the bank's `cr` and `ovn` when it rewrites `Credit(bank)`: until repos exist they are always 0, so no Flow 16 test does.

`open_repo` runs the closure, so a repo can make a full queue's offset feasible. At the cap of 62, full queues use up to 194 of the 200 writes, and 392 of the test host's 400 footprint entries, for a covered `submit` (SC-ST-08), and up to 16,280 of the 16,384 bytes of events and return value for a `submit` that completes an offset (SC-ST-10), with Stellar accounts as banks; `open_repo` writes more entries and publishes more events of its own (its own event and the SAC's mint), so price both. Price it at the cap, and lower the cap if it doesn't fit. Flow 16's review priced a throwaway `open_repo` (mint, `Credit(bank)`, a global repo counter, `Repo(id)`, the balance, then the closure) on the old cap of 63: 400 of the 400 entries on SC-ST-07's tree, 4 more than a deposit on the same queue, and 399 on SC-ST-05's path. Expect the same margin over a deposit at 62. Any further entry `open_repo` writes, such as a per-bank repo index, must be priced too.

- [x] `unit::credit::a_repo_mints_cash_into_the_contract_and_credits_the_bank` (SC-A12-01)
- [x] `unit::credit::credit_may_reach_but_not_exceed_the_collateral` (SC-A12-02)
- [x] `unit::credit::a_bank_with_no_collateral_gets_no_credit` (SC-A12-03)
- [x] `unit::credit::a_zero_or_negative_repo_is_refused` (SC-A12-04)
- [x] `unit::credit::credit_at_i128_max_is_checked_without_overflow` (SC-A12-05)
- [x] `unit::credit::a_repo_releases_the_banks_queue` (SC-A12-06)
- [x] `unit::credit::collateral_cannot_fall_below_the_credit_it_backs` (SC-A14-03)
- [x] `auth::open_repo_is_authorized_by_the_central_bank_with_the_mint` (SC-A12-07)
- [x] `auth::only_the_central_bank_can_open_a_repo` (SC-A12-07)

Added in Flow 17, and green:

- [x] `unit::credit::a_mint_the_token_refuses_is_reported` (SC-A12-08): `props.rs` demands a refused SAC mint come back as a contract error, so `open_repo` reports it as `TokenTransferFailed`. Its Red failed on the `todo!()`; it fails if `open_repo` calls `mint` rather than `try_mint`, since the refused mint then aborts the host (SC-A12-07's tree without the mint catches that too).
- [x] `unit::storage::a_repo_that_cascades_down_a_full_tree_fits_in_one_transaction` (SC-ST-13): 394 of the test host's 400 footprint entries and 195 of the 200 writes, 2 writes more than a deposit down the same tree (SC-ST-07), and the worst case for the footprint of any call at the cap.
- [x] `unit::storage::a_repo_that_completes_an_offset_over_a_full_queue_fits_in_one_transaction` (SC-ST-14): 391 entries and 16,120 of the 16,384 bytes of events and return value, below SC-ST-10's 16,280. So the cap stays at 62.
- [x] `unit::storage::a_repo_extends_the_instance_and_its_entries_to_thirty_days` (SC-ST-15), added in the review: `open_repo` extends the instance only through its mint, and SC-ST-03 cannot see that, since its `set_collateral` extends the instance in the same ledger. It kills the hand mutant that drops the extension from `mint` (pinned seed and seeds 1–4).

One decision is still open (README): who holds the SAC admin role. For now, the tests give it to the central bank's own account.

## Flow 18: repay, A13 with a burn (12)

The actor, either the bank or the central bank, authorizes the call. Anyone else is refused with `NotAuthorized`. `repay` also needs:
- `InvalidAmount`, `UnknownRepo`, `RepayExceedsRepo` and `InsufficientFunds`. When several guards fail, SC-P-02 expects `UnknownRepo`, then `NotAuthorized`, then `RepayExceedsRepo`, then `InsufficientFunds`;
- the debit and the burn from the contract;
- the status `Repaid` once nothing is outstanding;
- the `RepoRepaid` event.

- [x] `unit::credit::a_partial_repayment_burns_cash_and_lowers_the_credit` (SC-A13-01)
- [x] `unit::credit::a_full_repayment_closes_the_repo_and_frees_the_collateral` (SC-A13-02)
- [x] `unit::credit::the_central_bank_may_repay_on_the_banks_behalf` (SC-A13-03)
- [x] `unit::credit::a_third_party_cannot_repay` (SC-A13-04)
- [x] `auth::an_authorized_third_party_is_still_not_authorized_to_repay` (SC-A13-04)
- [x] `unit::credit::repaying_more_than_is_outstanding_is_refused` (SC-A13-05)
- [x] `unit::credit::a_bank_cannot_repay_more_than_its_balance` (SC-A13-06)
- [x] `unit::credit::a_zero_or_negative_repayment_is_refused` (SC-A13-07)
- [x] `unit::credit::repaying_an_unknown_repo_is_refused` (SC-A13-08)
- [x] `auth::repay_is_authorized_by_the_actor_alone` (SC-A13-09)
- [x] `auth::repay_by_the_central_bank_is_authorized_by_the_central_bank_alone` (SC-A13-09)
- [x] `auth::repay_without_the_actors_authorization_fails` (SC-A13-09)

Added in Flow 18, and green:

- [x] `unit::credit::a_burn_the_token_refuses_is_reported` (SC-A13-10): `props.rs` demands a refused SAC burn come back as a contract error, so `repay` reports it as `TokenTransferFailed`. Added in review, so it was shown red against hand mutants rather than a stub.

## Flow 19: the penalty repo, ADR-0014 and A20 (13)

`convert_overdue` needs no authorization. It refuses with:
- `NotOverdue` while `now <= opened_at + repo_term_secs`, and for a repaid repo;
- `AlreadyPenalty`;
- `UnknownRepo`.

Converting a repo moves its outstanding amount from `cr` to `ovn` and records the rate, with a `RepoPenalised` event. `repay` then lowers `ovn` for a penalty repo, and the collateral checks count `ovn`.

- [x] `unit::credit::an_overdue_repo_becomes_a_penalty_repo` (SC-A20-01)
- [x] `unit::credit::a_repo_exactly_at_its_term_is_not_overdue` (SC-A20-02)
- [x] `unit::credit::the_term_and_the_penalty_rate_are_configurable` (SC-A20-03)
- [x] `unit::credit::a_penalty_repo_cannot_be_converted_again` (SC-A20-04)
- [x] `unit::credit::a_repaid_repo_is_never_overdue` (SC-A20-05)
- [x] `unit::credit::converting_an_unknown_repo_is_refused` (SC-A20-06)
- [x] `unit::credit::a_penalty_repo_is_repaid_by_a_burn` (SC-A20-07)
- [x] `unit::credit::penalty_repos_stay_collateralised` (SC-A20-08). Dropping `ovn` from `open_repo`'s or `set_collateral`'s collateral check now fails it, under the pinned seed and seeds 1–4.
- [x] `auth::convert_overdue_needs_no_authorization` (SC-A20-09)

Added in Flow 19, and green:

- [x] `unit::credit::converting_one_of_two_repos_moves_only_its_own_amount` (SC-A20-10): every other test converts a bank's only repo, where `cr = 0` and `ovn = outstanding` pass for `cr -= outstanding` and `ovn += outstanding`. With two repos they don't. SC-P-01 and SC-P-02 rarely reach that case.
- [x] `unit::credit::a_term_that_would_overflow_never_passes` (SC-A20-11): the term saturates, so a term near `u64::MAX` never passes, where a wrapping sum would make the repo overdue at once.
- [x] `unit::credit::each_repo_is_repaid_from_its_own_side_of_the_credit` (SC-A20-12): every other test that repays meets one side only, a bank with only intraday repos or one repaying its only, penalty repo, so choosing the side by the bank's `ovn` rather than the repo's status passed them all. Added in review, so it was shown red against that hand mutant, `owed_by_ovn`, killed under the pinned seed and seeds 1–4.
- [x] `unit::storage::converting_an_overdue_repo_extends_the_instance_the_repo_and_the_credit` (SC-ST-16): SC-ST-03 runs `convert_overdue` in the ledger where `open_repo` already extended the repo, the credit and the instance, so it cannot see a conversion that extends none of them. This test converts once they are below the threshold again. Added in review, so it was shown red against hand mutants rather than a stub.

## Flow 20: every entry point extends every entry it writes (1)

The last unit test, since it calls every entry point.

- [ ] `unit::storage::every_entry_point_extends_every_entry_it_writes` (SC-ST-03)

It passes since Flow 19, which gave `convert_overdue` its code. But it runs every entry point in one ledger, so an entry point that writes an entry an earlier call already extended in that ledger passes without extending it. Flow 19's review found this for `convert_overdue` (now SC-ST-16) and `repay`. What is left is to make SC-ST-03 see it.

## Flow 21: the property and state-machine tests over random call sequences (2)

They call every entry point and every view, so they turn green last. A failure prints a shrunk call sequence; turn it into a unit test before fixing it. The requirements they add, and what they assume about expiry, are in `tests/SCENARIOS.md`, "Properties over many inputs".

- [ ] `props::the_safety_invariants_hold_for_any_call_sequence` (SC-P-01)
- [ ] `state_machine::the_contract_refines_the_reference_model` (SC-P-02)

Both pass since Flow 19. What is left is to check them against hand mutants (TESTING.md) and tick them. Flow 19's review found that neither reliably converts two repos of one bank, nor fully repays a penalty repo, nor repays an intraday repo beside a penalty repo: SC-A20-10, SC-A20-07 and SC-A20-12 catch those mutants at unit level, the property tests do not. `owed_by_ovn` survives SC-P-01 under every seed and is killed by SC-P-02 under the pinned seed and one of seeds 1–4.

## Totals

| | Tests |
|---|---|
| Already green (Flows 0 to 19) | 199 |
| Still to fix (Flows 20 to 21) | 3 |
| All | 202 |

The baseline had 132 tests, and the property and state-machine tests added 17. Flow 6 added SC-A01-17 and SC-P-10, Flow 7 added SC-A01-18 to SC-A01-22 and SC-P-11, Flow 8 added SC-A02-08, SC-A02-09 and SC-P-12, Flow 9 added SC-P-13, Flow 10 added SC-A08-09 to SC-A08-11 and SC-P-14, Flow 11 added SC-A05-10 and SC-P-15, Flow 12 added SC-A03-11's `core::balances_beyond_two_to_the_sixty_four_are_decided_exactly`, Flow 13 added three kernel tests of SC-A03-12 and SC-A03-13 to SC-A03-21, Flow 14 added SC-ST-05 to SC-ST-09, SC-A03-22 and SC-A03-23, Flow 15 added SC-A01-23, SC-A01-24, SC-ST-10 and SC-ST-11, Flow 16 added SC-ST-12, Flow 17 added SC-A12-08 and SC-ST-13 to SC-ST-15, Flow 18 added SC-A13-10, and Flow 19 added SC-A20-10 to SC-A20-12 and SC-ST-16.
