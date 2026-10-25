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

`QueueFull` refuses only a payment that would queue. A covered payment with nothing of its sender's queued ahead of it still settles.

- [x] `unit::payments::the_queue_cap_refuses_only_payments_that_would_queue` (SC-A01-09)
- [x] `unit::payments::one_below_the_queue_cap_a_payment_still_queues` (SC-A01-10). This is the boundary partner of SC-A01-09. Passed since Flow 5, and still passes with the cap.
- [x] `unit::payments::at_the_queue_cap_a_covered_payment_blocked_by_the_senders_queue_is_refused` (SC-A01-18). Added in Flow 7, since SC-A01-09's covered payment comes from a bank with nothing queued; it fails if the cap checks cover alone and lets a covered payment queue behind the sender's own past the cap. The sender's queued payments are urgent, and both a normal and an urgent payment are refused, so it also fails if only the same priority's queue counts as ahead.
- [x] `unit::payments::the_queue_cap_counts_every_banks_queue_and_refuses_an_urgent_payment_too` (SC-A01-19). Added in Flow 7, since it is the only cap test where the refused payment's sender has nothing queued and other banks fill the cap; it fails if the cap counts only the sender's queue, or (like SC-A01-18) applies to normal payments only. The refused payment is more than everything queued to its sender, so no offset could settle it, and the test holds whatever is decided about the cap and the offset.
- [x] `unit::payments::at_the_queue_cap_a1s_guards_come_before_queue_full` (SC-A01-20). Added in Flow 7, so that a unit test pins what SC-P-11 checks: it fails if `QueueFull` comes before `InvalidAmount` or `SameAccount`.
- [x] `unit::payments::at_the_queue_cap_a_covered_urgent_payment_settles_past_queued_normal_ones` (SC-A01-21). Added in Flow 7, SC-A01-13's case at the cap: it fails if the cap refuses an urgent payment because its bank has normal ones queued.
- [x] `unit::payments::a_settled_payment_does_not_count_toward_the_queue_cap` (SC-A01-22). Added in Flow 7, since no other cap test settles a payment before the cap is reached; it fails if the cap counts every payment submitted rather than those queued.
- [x] `props::submissions_never_queue_past_the_cap` (SC-P-11). Added in Flow 7: SC-P-01 checks the cap too, but only once every entry point exists (Flow 21), so this property runs deposits, withdrawals and submissions alone, with a cap of 3. At the cap it lets a payment that would not settle by cover either be refused or settle in its own submission, so it stays valid once Flow 13's offset exists. It counts the queued payments from their records, so it also fails if `queued_count` drifts from them, and it fails if `QueueFull` comes before A1's guards. It checks after every call that balances move only by the call's own deposit or withdrawal and the payments it settles (S4), conservation, that no balance goes negative and S7's order, so a payment that settles at the cap must be booked, paid for, and must not overtake its sender's queue. With no cap it fails: its shrunk case is a fourth uncovered payment queued past a cap of 3, which SC-A01-09 already pins. With a cap that checks cover alone it fails too: its shrunk case is a covered payment queued behind its sender's own at the cap, which SC-A01-18 already pins.

One decision is still open (README): what the cap does to a payment that would settle by offset. No unit test decides it, so add no behaviour for it here. But `quint/settlement.qnt` refuses a payment only if it is still queued after the closure, offset included, so it settles such a payment, and the replay (SC-MB-01) assumes it: traces 2, 28, 41 and 43 each settle one by offset.

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
- [x] `props::the_closure_leaves_every_queue_at_rest` (SC-P-12). Added in Flow 8: SC-P-01 checks S9 too, but only once every entry point exists (Flow 21), so this property runs deposits, withdrawals and submissions alone. It checks gross rest, no bank's head in `≺` covered, rather than k* = 0, so it stays valid once Flow 13's offset exists. It fails against each of these closures, and each shrunk case is one a unit test already pins: with no closure, a submission that settles and leaves its receiver's covered head queued (SC-A02-05); with no cascade, a deposit whose settlement leaves the receiver's covered head queued (SC-A02-04); with each bank visited once, a cascade that returns to a bank whose next head it now covers (SC-A02-08); and with no urgent block, a normal payment settled past its bank's uncovered urgent one (SC-A02-09). It reads only the views, which show an empty queue the same whether its entry is removed or kept, so a closure that keeps the entry of a queue it empties is left to SC-A02-08.

## Flow 9: revoke, A6 (11)

`revoke` needs:
- the sender's authorization;
- `UnknownPayment` and `NotQueued`;
- removal from the payment's queue;
- the `Revoked` event;
- then the closure.

- [ ] `unit::queue_management::a_queued_payment_can_be_revoked` (SC-A06-01)
- [ ] `unit::queue_management::revocation_has_no_cut_off` (SC-A06-02)
- [ ] `unit::queue_management::a_settled_payment_cannot_be_revoked` (SC-A06-03)
- [ ] `unit::queue_management::a_revoked_payment_cannot_be_revoked_again` (SC-A06-04)
- [ ] `unit::queue_management::revoking_an_unknown_payment_is_refused` (SC-A06-06)
- [ ] `unit::queue_management::revoking_the_head_releases_the_payment_behind_it` (SC-A06-07)
- [ ] `unit::queue_management::revoking_the_urgent_head_releases_normal_payments` (SC-A06-08)
- [ ] `unit::queue_management::revoking_from_the_middle_keeps_the_queue_order` (SC-A06-09)
- [ ] `unit::funding::withdraw_may_spend_what_a_queued_payment_would_need` (SC-A11-11)
- [ ] `auth::revoke_is_authorized_by_the_sender` (SC-A06-10)
- [ ] `auth::only_the_sender_can_revoke` (SC-A06-10)

## Flow 10: reprioritise, A8 (9)

The payment keeps its place by id. `reprioritise` needs:
- the sender's authorization;
- `SamePriority`, `NotQueued` and `UnknownPayment`, checked in the order SC-P-02 expects: `UnknownPayment`, `NotQueued`, `SamePriority`;
- the `Reprioritised` event;
- then the closure.

- [ ] `unit::queue_management::a_promoted_payment_keeps_its_place_by_age` (SC-A08-01)
- [ ] `unit::queue_management::a_demoted_payment_keeps_its_place_by_age` (SC-A08-02)
- [ ] `unit::queue_management::promoting_a_blocked_covered_payment_settles_it` (SC-A08-03)
- [ ] `unit::queue_management::demoting_an_uncovered_urgent_payment_releases_older_normal_ones` (SC-A08-04)
- [ ] `unit::queue_management::reprioritising_to_the_same_priority_is_refused` (SC-A08-05)
- [ ] `unit::queue_management::a_settled_payment_cannot_be_reprioritised` (SC-A08-06)
- [ ] `unit::queue_management::reprioritising_an_unknown_payment_is_refused` (SC-A08-07)
- [ ] `auth::reprioritise_is_authorized_by_the_sender` (SC-A08-08)
- [ ] `auth::only_the_sender_can_reprioritise` (SC-A08-08)

## Flow 11: expire, A5 under ADR-0015 (10)

`expire` needs no authorization. While `now <= submitted_at + expiry_secs`, it refuses with `NotExpired`. It also needs `NotQueued`, `UnknownPayment`, the `Expired` event and then the closure. When several guards fail, SC-P-02 expects `UnknownPayment`, then `NotQueued`, then `NotExpired`.

- [ ] `unit::queue_management::a_payment_past_its_expiry_can_be_expired` (SC-A05-01)
- [ ] `unit::queue_management::a_payment_exactly_at_its_expiry_has_not_expired` (SC-A05-02)
- [ ] `unit::queue_management::the_expiry_is_configurable` (SC-A05-03)
- [ ] `unit::queue_management::expiring_the_head_releases_the_payment_behind_it` (SC-A05-04)
- [ ] `unit::queue_management::each_payment_expires_from_its_own_submission` (SC-A05-05)
- [ ] `unit::queue_management::a_settled_payment_cannot_be_expired` (SC-A05-06)
- [ ] `unit::queue_management::a_revoked_payment_cannot_be_expired` (SC-A05-07)
- [ ] `unit::queue_management::expiring_an_unknown_payment_is_refused` (SC-A05-08)
- [ ] `unit::queue_management::an_expired_payment_cannot_be_revoked` (SC-A06-05)
- [ ] `auth::expire_needs_no_authorization` (SC-A05-09)

One decision is still open (README): whether a payment can still settle once its expiry has passed but before anyone has expired it. No unit test decides it, but `quint/settlement.qnt` and the tests built on it assume it can: the replay (SC-MB-01) and the property tests (SC-P-01, SC-P-02).

## Flow 12: the kernel's greatest feasible prefix (19)

A pure rule in `rtgs-core`: k* under Spec O, R4 and F1, with F1 decided over the integers: queued sums can exceed `i128`, and an overflow must not make a prefix infeasible (SC-A03-11). It depends on nothing, so it can be done at any time before Flow 13.

- [ ] `core::the_prefix_of_empty_queues_is_zero` (SC-A03-09)
- [ ] `core::when_everything_fits_the_prefix_is_every_candidate` (SC-A03-09)
- [ ] `core::an_uncovered_first_candidate_blocks_the_whole_queue` (SC-A03-09)
- [ ] `core::dropping_one_candidate_can_make_others_infeasible` (SC-A03-09)
- [ ] `core::the_prefix_does_not_depend_on_the_account_order` (SC-A03-09)
- [ ] `core::r7_cycle_has_prefix_one_one_one` (SC-A03-01)
- [ ] `core::the_descent_drops_the_last_candidate_of_a_violating_account` (SC-A03-03)
- [ ] `core::the_prefix_never_skips_an_earlier_candidate` (SC-A03-04)
- [ ] `core::a_prefix_that_leaves_an_account_negative_is_cut_back_at_the_i128_limit` (SC-A03-07)
- [ ] `core::props::the_prefix_is_within_every_queue` (SC-P-04)
- [ ] `core::props::the_prefix_is_feasible` (SC-P-04)
- [ ] `core::props::the_prefix_is_the_greatest_feasible_one` (SC-P-04)
- [ ] `core::props::the_prefix_does_not_depend_on_the_account_order` (SC-P-05)
- [ ] `core::props::more_liquidity_never_shrinks_the_prefix` (SC-P-05)
- [ ] `core::props::gross_processing_never_beats_the_offset` (SC-P-06)
- [ ] `core::props::after_the_offset_nothing_more_is_feasible` (SC-P-06)
- [ ] `core::props::a_candidate_no_inflow_can_cover_blocks_its_queue` (SC-P-07)
- [ ] `core::props::sums_beyond_i128_are_decided_exactly_not_a_panic` (SC-P-08)
- [ ] `core::props::at_the_i128_limit_sums_are_decided_exactly` (SC-A03-11)

## Flow 13: the LSM offset in the contract, A3 eager (10)

Build on Flows 8 and 12. Once gross settlement is at rest:
1. Build each bank's candidates in `≺` order: urgent first, then by id.
2. Apply k*, booking each bank's net change exactly: payment by payment, or every debit first, overflows at the `i128` limit (SC-A03-11, SC-A03-12).
3. Publish the `Offset` event, then one `Settled` event for each payment in it.
4. Run the closure again.

Before this flow, ask the user to settle the README decision on the queue cap and the offset. `quint/settlement.qnt` settles a payment that the offset settles, even at the cap. If that stands, first add a unit test, red against Flow 7's check before the closure: at the cap, an uncovered payment that the offset settles is accepted and settles (the README item has one). Then move `submit`'s cap check after the closure, so that it refuses only a payment still queued once the closure is done. If the user chooses to refuse, change `quint/settlement.qnt` and regenerate its traces instead, and add the README's test asserting `QueueFull`: it passes against Flow 7's check, so confirm it goes red against a check moved after the closure. Either way, then narrow SC-P-11's branch at the cap to the chosen answer: with `reference::greatest_feasible_prefix` over the queues plus the new payment, require `Ok(id)` and `Settled` when the prefix takes it and `QueueFull` when it does not ("settle"), or `QueueFull` whenever cover alone does not settle it ("refuse"). Update its doc comment, SCENARIOS row and StillToFix line. SC-P-11 must stay green with the offset: its S4 check sums exactly, so payments of `i128::MAX` settled by offset do not overflow it.

Step 1 needs every bank with a queued payment. Since Flow 5, queues are stored one per `Queue(bank, priority)` and the contract keeps no list of banks, so the offset needs a persistent index of the banks with queued payments. That index could replace `QueuedCount`.

- [ ] `unit::lsm::r7_gridlock_is_resolved_in_the_submission_that_makes_it_feasible` (SC-A03-01)
- [ ] `unit::lsm::two_opposite_payments_offset_with_no_liquidity` (SC-A03-02)
- [ ] `unit::lsm::the_offset_settles_the_greatest_feasible_prefix_and_leaves_the_rest` (SC-A03-03)
- [ ] `unit::lsm::the_offset_never_overtakes_an_older_payment` (SC-A03-04). Passes since Flow 5, because there is no offset yet. Check that it still passes once the offset exists, then tick it.
- [ ] `unit::lsm::the_offset_takes_a_banks_urgent_payments_before_its_normal_ones` (SC-A03-05). Passes since Flow 5, because there is no offset yet. Check that it still passes once the offset exists, then tick it.
- [ ] `unit::lsm::a_deposit_can_make_an_offset_feasible` (SC-A03-06)
- [ ] `unit::lsm::at_the_i128_limit_the_offset_cuts_back_the_prefix_that_would_leave_a_bank_negative` (SC-A03-07)
- [ ] `unit::lsm::after_an_offset_the_queues_are_at_rest` (SC-A03-08)
- [ ] `unit::lsm::an_offset_whose_sums_exceed_i128_still_settles` (SC-A03-11)
- [ ] `unit::lsm::an_offset_books_each_banks_net_change_exactly` (SC-A03-12)

## Flow 14: the offset's cost at the queue cap (1)

This test registers the contract from its Wasm, so run `make build` first. If an offset over 64 payments doesn't fit Mainnet's per-transaction limits, lower `QUEUE_CAP_UNDER_TEST` and record why.

- [ ] `unit::storage::an_offset_over_a_full_queue_fits_in_one_transaction` (SC-ST-04)

## Flow 15: the model-based replay (1)

The 50 committed Quint traces call deposit, withdraw, submit, revoke, reprioritise, expire and tick. The replay needs Flows 1 to 13.

- [ ] `itf_replay::quint_traces_replay_against_the_contract` (SC-MB-01)

## Flow 16: collateral, A14 (4)

Implement the `credit()` view, and `set_collateral` with:
- the central bank's authorization;
- `InvalidAmount`;
- the `CollateralSet` event.

- [ ] `unit::credit::the_central_bank_sets_a_banks_collateral` (SC-A14-01)
- [ ] `unit::credit::collateral_can_be_zero_but_not_negative` (SC-A14-02)
- [ ] `auth::set_collateral_is_authorized_by_the_central_bank` (SC-A14-04)
- [ ] `auth::only_the_central_bank_can_set_collateral` (SC-A14-04)

## Flow 17: open a repo, A12 with a mint (9)

`open_repo` needs:
- the central bank's authorization, with the SAC `mint` into the contract in the same tree;
- `InvalidAmount`;
- `CreditExceedsCollateral`, checked without overflow;
- the `Repo` record and the `repo()` view;
- the `RepoOpened` event;
- then the closure.

`set_collateral` also gains its `CollateralBelowCredit` check.

- [ ] `unit::credit::a_repo_mints_cash_into_the_contract_and_credits_the_bank` (SC-A12-01)
- [ ] `unit::credit::credit_may_reach_but_not_exceed_the_collateral` (SC-A12-02)
- [ ] `unit::credit::a_bank_with_no_collateral_gets_no_credit` (SC-A12-03)
- [ ] `unit::credit::a_zero_or_negative_repo_is_refused` (SC-A12-04)
- [ ] `unit::credit::credit_at_i128_max_is_checked_without_overflow` (SC-A12-05)
- [ ] `unit::credit::a_repo_releases_the_banks_queue` (SC-A12-06)
- [ ] `unit::credit::collateral_cannot_fall_below_the_credit_it_backs` (SC-A14-03)
- [ ] `auth::open_repo_is_authorized_by_the_central_bank_with_the_mint` (SC-A12-07)
- [ ] `auth::only_the_central_bank_can_open_a_repo` (SC-A12-07)

One decision is still open (README): who holds the SAC admin role. For now, the tests give it to the central bank's own account.

## Flow 18: repay, A13 with a burn (12)

The actor, either the bank or the central bank, authorizes the call. Anyone else is refused with `NotAuthorized`. `repay` also needs:
- `InvalidAmount`, `UnknownRepo`, `RepayExceedsRepo` and `InsufficientFunds`. When several guards fail, SC-P-02 expects `UnknownRepo`, then `NotAuthorized`, then `RepayExceedsRepo`, then `InsufficientFunds`;
- the debit and the burn from the contract;
- the status `Repaid` once nothing is outstanding;
- the `RepoRepaid` event.

- [ ] `unit::credit::a_partial_repayment_burns_cash_and_lowers_the_credit` (SC-A13-01)
- [ ] `unit::credit::a_full_repayment_closes_the_repo_and_frees_the_collateral` (SC-A13-02)
- [ ] `unit::credit::the_central_bank_may_repay_on_the_banks_behalf` (SC-A13-03)
- [ ] `unit::credit::a_third_party_cannot_repay` (SC-A13-04)
- [ ] `auth::an_authorized_third_party_is_still_not_authorized_to_repay` (SC-A13-04)
- [ ] `unit::credit::repaying_more_than_is_outstanding_is_refused` (SC-A13-05)
- [ ] `unit::credit::a_bank_cannot_repay_more_than_its_balance` (SC-A13-06)
- [ ] `unit::credit::a_zero_or_negative_repayment_is_refused` (SC-A13-07)
- [ ] `unit::credit::repaying_an_unknown_repo_is_refused` (SC-A13-08)
- [ ] `auth::repay_is_authorized_by_the_actor_alone` (SC-A13-09)
- [ ] `auth::repay_by_the_central_bank_is_authorized_by_the_central_bank_alone` (SC-A13-09)
- [ ] `auth::repay_without_the_actors_authorization_fails` (SC-A13-09)

## Flow 19: the penalty repo, ADR-0014 and A20 (9)

`convert_overdue` needs no authorization. It refuses with:
- `NotOverdue` while `now <= opened_at + repo_term_secs`, and for a repaid repo;
- `AlreadyPenalty`;
- `UnknownRepo`.

Converting a repo moves its outstanding amount from `cr` to `ovn` and records the rate, with a `RepoPenalised` event. `repay` then lowers `ovn` for a penalty repo, and the collateral checks count `ovn`.

- [ ] `unit::credit::an_overdue_repo_becomes_a_penalty_repo` (SC-A20-01)
- [ ] `unit::credit::a_repo_exactly_at_its_term_is_not_overdue` (SC-A20-02)
- [ ] `unit::credit::the_term_and_the_penalty_rate_are_configurable` (SC-A20-03)
- [ ] `unit::credit::a_penalty_repo_cannot_be_converted_again` (SC-A20-04)
- [ ] `unit::credit::a_repaid_repo_is_never_overdue` (SC-A20-05)
- [ ] `unit::credit::converting_an_unknown_repo_is_refused` (SC-A20-06)
- [ ] `unit::credit::a_penalty_repo_is_repaid_by_a_burn` (SC-A20-07)
- [ ] `unit::credit::penalty_repos_stay_collateralised` (SC-A20-08)
- [ ] `auth::convert_overdue_needs_no_authorization` (SC-A20-09)

## Flow 20: every entry point extends every entry it writes (1)

The last unit test, since it calls every entry point.

- [ ] `unit::storage::every_entry_point_extends_every_entry_it_writes` (SC-ST-03)

## Flow 21: the property and state-machine tests over random call sequences (2)

They call every entry point and every view, so they turn green last. A failure prints a shrunk call sequence; turn it into a unit test before fixing it. The requirements they add, and what they assume about expiry, are in `tests/SCENARIOS.md`, "Properties over many inputs".

- [ ] `props::the_safety_invariants_hold_for_any_call_sequence` (SC-P-01)
- [ ] `state_machine::the_contract_refines_the_reference_model` (SC-P-02)

## Totals

| | Tests |
|---|---|
| Already green (Flows 0 to 8) | 62 |
| Still to fix (Flows 9 to 21) | 98 |
| All | 160 |

The baseline had 132 tests, and the property and state-machine tests added 17. Flow 6 added SC-A01-17 and SC-P-10, Flow 7 added SC-A01-18 to SC-A01-22 and SC-P-11, and Flow 8 added SC-A02-08, SC-A02-09 and SC-P-12.
