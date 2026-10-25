# Scenario catalogue

Every behaviour the system must show, with the tests that run it (TESTING.md, "Scenario catalogue"). Scenarios are numbered by the model action they exercise (`../stellar-research/definition/rtgs-definition.md` §4.6), so a family with no rows is an action with no test.

- Deposit and withdraw are A11 (definition §5.5): a transfer between a bank's trustline holding of the cash token and its settlement balance in the contract.
- `storage::` rows (SC-ST) are about the ledger, not the model: storage lifetime and transaction cost.
- Test paths are relative to the `settlement` crate: `unit::…` stands for `tests::unit::…`, and `auth::…` for `tests::auth::…`.
- `core::…` stands for `rtgs_core::tests::…`, and `core::props::…` for `rtgs_core::props::…`.
- `integration/…` rows (SC-IT, SC-H) run on the local devnet (TESTING.md §4). They cover what the test host can't show: issuer flags, trustlines, real signatures, RPC and on-chain TTL.
- `itf_replay::…` stands for `tests::itf_replay::…`, and `qnt::…` for a `run` in `quint/settlement_test.qnt`.
- `props::…`, `state_machine::…` and `reference::…` stand for `tests::props::…`, `tests::state_machine::…` and `tests::reference::…`.
- The SC-P rows are listed only in their own section, "Properties over many inputs", not in the Test column of the action rows whose behaviour they also run.

**Status, 2026-10-24.** The tests are written and red. Only the constructor, `deposit` with its guards, `withdraw`, `submit`, the `balance`, `payment`, `queue`, `queued_count`, `config` and `central_bank` views and the kernel's `covers` have code. `submit` settles a covered payment at once and queues any other, with no queue discipline, cap or closure yet. The tests that exercise only this code pass: SC-A11-01 to SC-A11-10, SC-A11-12 to SC-A11-16, SC-A01-01 to SC-A01-08, SC-A01-16, SC-A03-10, SC-P-03, SC-ST-01 and SC-ST-02, and on the devnet SC-IT-01 to SC-IT-06. SC-P-09 passes too: it checks the reference rule the property tests are judged by. So do SC-MB-02 and SC-MB-01's event-matching helper. The tests of SC-A01-10, SC-A01-13, SC-A02-06 and SC-A02-07, and the `unit::lsm::…` tests of SC-A03-04 and SC-A03-05, also pass, but only because the queue discipline, cap, closure and offset they guard against don't exist yet. SC-A01-14 passes too, since cover is checked against the sender's balance alone; it is re-checked once queue discipline exists. SC-A03-04's `core::…` test is still red. Every other test fails, against `todo!()` stubs or missing behaviour, until it is implemented test first.

## A11 `LiquidityTransfer`: deposit and withdraw

A11's guard `phase = Open` does not apply, since there is no business day (ADR-0013).

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A11-01 | B holds 1,000 cash tokens | B deposits 600 | B holds 400, the contract 600; `balance(B)` = 600; one `Deposited` event | A11, S1, S4 | 0003, 0004 | `unit::funding::deposit_moves_tokens_into_the_contract_and_credits_the_bank` |
| SC-A11-02 | A and B hold 1,000 each | A deposits 400 then 600; B deposits 250 then 50 | balances 1,000 and 300; the contract holds 1,300 | A11, S1 | 0004 | `unit::funding::deposit_of_exactly_the_banks_holding_succeeds_and_deposits_add_up` |
| SC-A11-03 | B holds 1,000 | B deposits 0, −1 or `i128::MIN` | `InvalidAmount`; nothing moves | A11, S1 | 0004 | `unit::funding::deposit_of_zero_or_a_negative_amount_is_refused` |
| SC-A11-04 | B holds 1,000 | B deposits 1,001 | `TokenTransferFailed`; nothing moves | A11, S1 | 0003 | `unit::funding::deposit_of_one_more_than_the_bank_holds_is_refused` |
| SC-A11-05 | the contract holds `i128::MAX` | another bank deposits 1 | the SAC refuses: `TokenTransferFailed` | A11, S1 | 0003 | `unit::funding::deposit_that_would_overflow_the_contracts_holding_is_refused_by_the_sac` |
| SC-A11-06 | B's balance is 1,000 | B withdraws 300 | balance 700; B holds 300; one `Withdrawn` event | A11, S1, S4 | 0004 | `unit::funding::withdraw_debits_the_bank_and_pays_the_tokens_out` |
| SC-A11-07 | B's balance is `i128::MAX` | B withdraws all of it | balance 0 | A11, S1 | 0004 | `unit::funding::withdraw_of_exactly_the_balance_leaves_zero_even_at_i128_max` |
| SC-A11-08 | B's balance is 1,000 | B withdraws 1,001 | `InsufficientFunds`; nothing moves | A11, S2 | 0011 | `unit::funding::withdraw_of_one_more_than_the_balance_is_refused` |
| SC-A11-09 | B's balance is 1,000 | B withdraws 0, −1 or `i128::MIN` | `InvalidAmount` | A11, S1 | 0004 | `unit::funding::withdraw_of_zero_or_a_negative_amount_is_refused` |
| SC-A11-10 | B never deposited | B withdraws 1 | `InsufficientFunds` | A11, S2 | 0004 | `unit::funding::withdraw_by_a_bank_with_no_balance_is_refused` |
| SC-A11-11 | B has 50 and queues 60, then 10 behind it | B withdraws 45 and revokes the 60 | the 10 stays queued, uncovered: nothing is reserved | A11, S2 | 0018 | `unit::funding::withdraw_may_spend_what_a_queued_payment_would_need` |
| SC-A11-12 | any setup | deposit or withdraw with and without the bank's authorization | the bank authorizes the call (and, for deposit, the transfer); without it the call fails with `Error(Context, InvalidAction)` and nothing moves, and with exactly the bank's tree it succeeds | A11, S6 | 0004 | `auth::deposit_is_authorized_by_the_bank_for_itself_and_the_transfer`, `auth::deposit_without_the_banks_authorization_fails`, `auth::withdraw_is_authorized_by_the_bank_alone`, `auth::withdraw_without_the_banks_authorization_fails` |
| SC-A11-13 | a contract constructed with a config and a central bank | read them back | the same values | S6 | 0010, 0011, 0014, 0015 | `unit::funding::the_constructor_records_the_configuration_and_the_central_bank` |
| SC-A11-14 | B never deposited | read `balance(B)` | 0 | §4.4 initial state | 0004 | `unit::funding::balance_of_an_unknown_bank_is_zero` |
| SC-A11-15 | the issuer deauthorized B | B deposits 600 | `TokenTransferFailed`; nothing moves | A11, S1 | 0003 | `unit::funding::a_deauthorized_bank_cannot_deposit` |
| SC-A11-16 | B's balance is 1,000; the issuer deauthorized B | B withdraws 300 | `TokenTransferFailed`; the balance is unchanged | A11, S1, S2 | 0003 | `unit::funding::a_withdrawal_to_a_deauthorized_bank_is_refused` |

## A1 `Submit`

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A01-01 | A has 100 | A pays B 40 | settles at once, id 0; `Submitted` then `Settled`; A 60, B 40 | A1, A2, S4, S11, L1 | 0005, 0008 | `unit::payments::a_covered_payment_settles_at_once` |
| SC-A01-02 | A has 100 | A pays B 100 | settles; A 0 | S2 | 0011 | `unit::payments::a_payment_of_exactly_the_balance_settles` |
| SC-A01-03 | A has 100 | A pays B 101 | queued in A's normal queue; nothing moves | A1, S2 | 0008 | `unit::payments::a_payment_of_one_more_than_the_balance_is_queued` |
| SC-A01-04 | A never deposited | A pays B 1 | queued | A1 | 0008 | `unit::payments::a_bank_with_no_balance_can_queue_a_payment` |
| SC-A01-05 | A has 100 | A pays 0, −1 or `i128::MIN` | `InvalidAmount`; no id used | A1, S11 | — | `unit::payments::a_zero_or_negative_payment_is_refused` |
| SC-A01-06 | A has 100 | A pays itself | `SameAccount` | A1, S11 | — | `unit::payments::a_payment_to_oneself_is_refused` |
| SC-A01-07 | — | payments of `i128::MAX`, uncovered and covered | queues, or settles with no overflow | S1, S11 | — | `unit::payments::a_payment_of_i128_max_queues_or_settles_without_overflow` |
| SC-A01-08 | — | four payments across banks and priorities | ids 0, 1, 2, 3 | S11 | 0008 | `unit::payments::ids_are_increasing_sequence_numbers` |
| SC-A01-09 | `queue_cap` = 2, two payments queued | another uncovered payment; a covered one | `QueueFull`; the covered one settles | A1 | 0010 | `unit::payments::the_queue_cap_refuses_only_payments_that_would_queue` |
| SC-A01-10 | `queue_cap` = 2, one queued | a second uncovered payment | queued | A1 | 0010 | `unit::payments::one_below_the_queue_cap_a_payment_still_queues` |
| SC-A01-11 | A has 50, queues normal 60 | A pays normal 10 | the 10 queues behind the 60 | S7(b) | 0008 | `unit::payments::a_covered_payment_waits_behind_an_uncovered_one_of_the_same_priority` |
| SC-A01-12 | A has 50, queues urgent 60 | A pays normal 10 | the 10 queues | S7(a) | 0009 | `unit::payments::a_queued_urgent_payment_blocks_the_banks_normal_payments` |
| SC-A01-13 | A has 50, queues normal 60 | A pays urgent 10 | the 10 settles at once | S7(a) | 0009 | `unit::payments::an_urgent_payment_settles_ahead_of_queued_normal_ones` |
| SC-A01-14 | A's queue blocked; B has 50 | B pays 50 | settles | §4.5 `≺` | 0008 | `unit::payments::one_banks_blocked_queue_does_not_block_another_bank` |
| SC-A01-15 | CPSS Box 4: A has 100 | A queues 40, 70, 20, 30, 10 | only the 40 settles | S7, §4.11 | 0008 | `unit::payments::cpss_box_4_strict_fifo_settles_only_the_first_payment` |
| SC-A01-16 | any | submit by the sender, by no one, by the receiver | the sender's tree only; the others fail | S6 | — | `auth::submit_is_authorized_by_the_sender_alone`, `auth::submit_without_the_senders_authorization_fails`, `auth::the_receiver_cannot_submit_a_payment_from_the_sender` |

## A2 `Settle`: the eager closure

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A02-01 | A queued 30 with 0 | A deposits 30 | settles in the same call; `Deposited`, then `Settled` | A2, S9, L1 (δ = 0) | 0010 | `unit::payments::a_deposit_that_covers_the_head_settles_it_in_the_same_call` |
| SC-A02-02 | A queued 30, 20, 50 | A deposits 60 | the 30 and the 20 settle; the 50 waits | S7, S9 | 0008 | `unit::payments::new_liquidity_settles_the_queue_in_order_up_to_the_first_uncovered_payment` |
| SC-A02-03 | A queued normal 20, urgent 20 | A deposits 30 | the urgent settles; the normal waits | S7(a) | 0009 | `unit::payments::new_liquidity_settles_urgent_payments_before_normal_ones` |
| SC-A02-04 | A→B 30 and B→C 30 queued | A deposits 30 | both settle | S9 | 0010 | `unit::payments::a_settlement_cascades_through_the_receivers_queue` |
| SC-A02-05 | B→C 30 queued | A (with 30) pays B 30 | both settle in the submit, the new one first | S9 | 0010 | `unit::payments::a_submission_that_settles_releases_the_receivers_queue` |
| SC-A02-06 | A queued 60 | A withdraws 10 | only `Withdrawn` | S9 | 0018 | `unit::payments::a_withdrawal_settles_nothing` |
| SC-A02-07 | a settled payment | time passes, more payments and a withdrawal | its record is unchanged | S3, S5 | 0005, 0006 | `unit::payments::a_settled_payment_never_changes` |

## A3 `Offset` (Spec O, eager)

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A03-01 | R7: balances 10 each; A→B 15, B→C 20 queued | C pays A 25 | `Offset` [0, 1, 2], three `Settled`; balances 20, 5, 5 | A3, S10, S23, R7, L2 | 0010 | `unit::lsm::r7_gridlock_is_resolved_in_the_submission_that_makes_it_feasible`, `core::r7_cycle_has_prefix_one_one_one` |
| SC-A03-02 | A and B have 0 | A→B 50, then B→A 50 | both settle | A3, F1 | 0010 | `unit::lsm::two_opposite_payments_offset_with_no_liquidity` |
| SC-A03-03 | A queued 50, 30 to B | B pays A 50 | offset of A's 50 and B's 50; A's 30 waits | R4, Spec O | 0010 | `unit::lsm::the_offset_settles_the_greatest_feasible_prefix_and_leaves_the_rest`, `core::the_descent_drops_the_last_candidate_of_a_violating_account` |
| SC-A03-04 | A queued 100, 50 to B | B pays A 50 | nothing settles: no overtaking | F2, F6, S7 | 0008, 0010 | `unit::lsm::the_offset_never_overtakes_an_older_payment`, `core::the_prefix_never_skips_an_earlier_candidate` |
| SC-A03-05 | A queued normal 50, then urgent 100 | B pays A 50 | nothing settles: urgent first in `≺` | §4.5, F2 | 0009, 0010 | `unit::lsm::the_offset_takes_a_banks_urgent_payments_before_its_normal_ones` |
| SC-A03-06 | A→B 60, B→A 50 queued | A deposits 10 | both settle by offset | A3, S23 | 0010 | `unit::lsm::a_deposit_can_make_an_offset_feasible` |
| SC-A03-07 | B queued two `i128::MAX` to A | A pays B `i128::MAX` | offset of one each; no panic: with both, B would end at −`i128::MAX` | R4, F1 | 0010 | `unit::lsm::at_the_i128_limit_the_offset_cuts_back_the_prefix_that_would_leave_a_bank_negative`, `core::a_prefix_that_leaves_an_account_negative_is_cut_back_at_the_i128_limit` |
| SC-A03-08 | after an offset | a submission that adds nothing feasible | nothing more settles | R5, S23 | 0010 | `unit::lsm::after_an_offset_the_queues_are_at_rest` |
| SC-A03-09 | the prefix rule alone | empty queues; all fit; an uncovered first candidate; a cascade of drops; relabelled accounts | k* as stated | R4, R9 | 0010 | `core::the_prefix_of_empty_queues_is_zero`, `core::when_everything_fits_the_prefix_is_every_candidate`, `core::an_uncovered_first_candidate_blocks_the_whole_queue`, `core::dropping_one_candidate_can_make_others_infeasible`, `core::the_prefix_does_not_depend_on_the_account_order` |
| SC-A03-10 | the cover rule alone | balances and amounts at the boundaries | `bal − a ≥ 0` | §4.5 `cov` | 0011 | `core::covers_is_balance_minus_amount_at_least_zero` |
| SC-A03-11 | A has 1, B nothing; A queued A→B twice `i128::MAX / 2 + 1`, one more than `i128::MAX` in all | B submits B→A `i128::MAX` | k* = (2, 1): all three settle, A ends at 0 and B at 1. F1 is decided over the integers: an outflow that overflows `i128` is not infeasible for that reason | A3, F1, R4, R5, S23 | 0010 | `unit::lsm::an_offset_whose_sums_exceed_i128_still_settles`, `core::props::at_the_i128_limit_sums_are_decided_exactly` |
| SC-A03-12 | balances 0; A→B, A→C and C→A, all `i128::MAX`, queued in that order | B submits B→A `i128::MAX` | k* = (2, 1, 1): all four settle, every balance ends at 0; each bank's net change is booked exactly, since debiting first or booking payment by payment in id order overflows | A3, S1, S2 | 0010 | `unit::lsm::an_offset_books_each_banks_net_change_exactly` |

## A4 `Lock` and `Unlock`

Not applicable: the LSM is one-phase (ADR-0010), so there are no locks and S18 and S22 hold vacuously.

## A5 `Reject`: expiry

Expiry counted from submission replaces the model's τ_qc (ADR-0013, ADR-0015).

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A05-01 | a payment queued at t | expire at t + expiry + 1 | `Expired`; out of the queue | A5 | 0015 | `unit::queue_management::a_payment_past_its_expiry_can_be_expired` |
| SC-A05-02 | queued at t | expire at t and at t + expiry | `NotExpired` | A5 | 0015 | `unit::queue_management::a_payment_exactly_at_its_expiry_has_not_expired` |
| SC-A05-03 | `expiry_secs` = 10 | at +10 and +11 | `NotExpired`, then expired | A5 | 0015 | `unit::queue_management::the_expiry_is_configurable` |
| SC-A05-04 | A has 50; queued 60, then 10 | the 60 expires | the 10 settles in the same call | A5, S9 | 0010, 0015 | `unit::queue_management::expiring_the_head_releases_the_payment_behind_it` |
| SC-A05-05 | two payments queued 100 s apart | the first's expiry passes | the first expires; the second is `NotExpired` | A5 | 0015 | `unit::queue_management::each_payment_expires_from_its_own_submission` |
| SC-A05-06 | a settled payment | expire it | `NotQueued` | S3, S5 | 0015 | `unit::queue_management::a_settled_payment_cannot_be_expired` |
| SC-A05-07 | a revoked payment | expire it | `NotQueued` | S3 | 0015 | `unit::queue_management::a_revoked_payment_cannot_be_expired` |
| SC-A05-08 | — | expire an unknown id | `UnknownPayment` | — | 0015 | `unit::queue_management::expiring_an_unknown_payment_is_refused` |
| SC-A05-09 | no authorization at all | expire | succeeds; no auths recorded | S6, M1 | 0015 | `auth::expire_needs_no_authorization` |

## A6 `Revoke`

Revocation is allowed until settlement, with no cut-off τ_rc (ADR-0016), so S20 holds trivially.

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A06-01 | a queued payment | the sender revokes | `Revoked`; out of the queue | A6, S13 | 0016 | `unit::queue_management::a_queued_payment_can_be_revoked` |
| SC-A06-02 | queued long past its expiry time | revoke | revoked: no cut-off | A6 | 0016 | `unit::queue_management::revocation_has_no_cut_off` |
| SC-A06-03 | a settled payment | revoke | `NotQueued`; nothing changes | S3, S5, M5 | 0005, 0006 | `unit::queue_management::a_settled_payment_cannot_be_revoked` |
| SC-A06-04 | a revoked payment | revoke again | `NotQueued` | S3 | 0016 | `unit::queue_management::a_revoked_payment_cannot_be_revoked_again` |
| SC-A06-05 | an expired payment | revoke | `NotQueued` | S3 | 0015 | `unit::queue_management::an_expired_payment_cannot_be_revoked` |
| SC-A06-06 | — | revoke an unknown id | `UnknownPayment` | — | — | `unit::queue_management::revoking_an_unknown_payment_is_refused` |
| SC-A06-07 | A has 50; queued 60, then 10 | revoke the 60 | the 10 settles in the same call | A6, S9 | 0016 | `unit::queue_management::revoking_the_head_releases_the_payment_behind_it` |
| SC-A06-08 | A has 50; queued urgent 60, normal 10 | revoke the urgent | the normal settles | S7(a) | 0009, 0016 | `unit::queue_management::revoking_the_urgent_head_releases_normal_payments` |
| SC-A06-09 | three queued | revoke the middle one | the others keep their order | S7 | 0008 | `unit::queue_management::revoking_from_the_middle_keeps_the_queue_order` |
| SC-A06-10 | a queued payment | revoke by the sender, by the receiver, by no one | the sender's tree; the others fail | S6, S13 | 0016 | `auth::revoke_is_authorized_by_the_sender`, `auth::only_the_sender_can_revoke` |

## A7 `Hold`

Not in v1: κ-proto's `mgmt` is Repri only (ADR-0009).

## A8 `Reprioritise`

The payment keeps its sequence number, which is the model's toEnd = false. This was decided with the user on 2026-10-24.

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A08-01 | urgent 0, normal 1, urgent 2 | promote 1 | urgent queue [0, 1, 2]; `Reprioritised` | A8 | 0009 | `unit::queue_management::a_promoted_payment_keeps_its_place_by_age` |
| SC-A08-02 | normal 0, urgent 1, normal 2 | demote 1 | normal queue [0, 1, 2] | A8 | 0009 | `unit::queue_management::a_demoted_payment_keeps_its_place_by_age` |
| SC-A08-03 | A has 50; normal 60, then 10 | promote the 10 | it settles in the same call | A8, S9 | 0009, 0010 | `unit::queue_management::promoting_a_blocked_covered_payment_settles_it` |
| SC-A08-04 | A has 10; normal 10, then urgent 60 | demote the 60 | the 10 settles | A8, S7(a) | 0009 | `unit::queue_management::demoting_an_uncovered_urgent_payment_releases_older_normal_ones` |
| SC-A08-05 | a queued normal payment | reprioritise to normal | `SamePriority` | A8 | 0009 | `unit::queue_management::reprioritising_to_the_same_priority_is_refused` |
| SC-A08-06 | a settled payment | reprioritise | `NotQueued` | S3, S5 | 0009 | `unit::queue_management::a_settled_payment_cannot_be_reprioritised` |
| SC-A08-07 | — | an unknown id | `UnknownPayment` | — | 0009 | `unit::queue_management::reprioritising_an_unknown_payment_is_refused` |
| SC-A08-08 | a queued payment | reprioritise by the sender, the receiver, no one | the sender's tree; the others fail | S6 | 0009 | `auth::reprioritise_is_authorized_by_the_sender`, `auth::only_the_sender_can_reprioritise` |

## A9 `Retime`, A10 reserves and limits

- **A9:** not in v1. There are no timed orders (ADR-0017).
- **A10:** not in v1. There are no reservations or limits (ADR-0018), so S14 and S15 hold vacuously.
- **A11:** see "A11 `LiquidityTransfer`" above. A bank's two accounts are its trustline holding and its settlement balance.

## A12 `Credit` (Repo), A14 `SetCollateral`

Collateral is a value the CB sets, as in A14, with no collateral token. This was decided with the user on 2026-10-24. A12's guard `phase = Open` does not apply (ADR-0013).

The CB's own account is the SAC admin, so it authorizes the mint inside `open_repo`. That is provisional: as admin, it could also claw back from, or deauthorize, the contract outside the contract's recorded paths (review finding H1). Whether an issuance controller contract should hold the admin role instead is open for the user.

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A14-01 | — | the CB sets B's collateral to 100 | `credit(B)` = (0, 0, 100); `CollateralSet` | A14 | 0011 | `unit::credit::the_central_bank_sets_a_banks_collateral` |
| SC-A14-02 | collateral 100 | set to 0; set to −1 | 0 allowed; `InvalidAmount` | A14 | 0011 | `unit::credit::collateral_can_be_zero_but_not_negative` |
| SC-A14-03 | cr = 60 | set collateral to 59, then 60 | `CollateralBelowCredit`, then allowed | A14, S17, S21 | 0011 | `unit::credit::collateral_cannot_fall_below_the_credit_it_backs` |
| SC-A14-04 | — | set_collateral by the CB, by the bank, by no one | the CB's tree; the others fail | S6 | 0011 | `auth::set_collateral_is_authorized_by_the_central_bank`, `auth::only_the_central_bank_can_set_collateral` |
| SC-A12-01 | collateral 100 | the CB opens a repo of 60 | 60 minted into the contract; B's balance 60; cr 60; repo recorded; `RepoOpened` | A12, S1, S4 | 0011 | `unit::credit::a_repo_mints_cash_into_the_contract_and_credits_the_bank` |
| SC-A12-02 | collateral 100 | repos of 60 and 40, then 1 | allowed, then `CreditExceedsCollateral` | A12, S17 | 0011 | `unit::credit::credit_may_reach_but_not_exceed_the_collateral` |
| SC-A12-03 | no collateral | a repo of 1 | `CreditExceedsCollateral` | S17 | 0011 | `unit::credit::a_bank_with_no_collateral_gets_no_credit` |
| SC-A12-04 | collateral 100 | a repo of 0 or less | `InvalidAmount` | A12 | 0011 | `unit::credit::a_zero_or_negative_repo_is_refused` |
| SC-A12-05 | collateral `i128::MAX` | repo `i128::MAX`, then 1 | allowed, then refused, with no overflow | S17 | 0011 | `unit::credit::credit_at_i128_max_is_checked_without_overflow` |
| SC-A12-06 | B queued 50 with 0 | a repo of 50 | the payment settles in the same call | A12, S9, L1 | 0010, 0011 | `unit::credit::a_repo_releases_the_banks_queue` |
| SC-A12-07 | — | open_repo by the CB, by the bank, by no one | the CB's tree with the SAC `mint`; the others fail and nothing is minted | S6, D1 | 0011 | `auth::open_repo_is_authorized_by_the_central_bank_with_the_mint`, `auth::only_the_central_bank_can_open_a_repo` |

## A13 `Repay`

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A13-01 | a repo of 60 | B repays 20 | balance 40; 20 burned; cr 40; `RepoRepaid` | A13, S1, S4 | 0011 | `unit::credit::a_partial_repayment_burns_cash_and_lowers_the_credit` |
| SC-A13-02 | a repo of 60 | B repays 60 | `Repaid`; cr 0; collateral freed | A13, S17 | 0011 | `unit::credit::a_full_repayment_closes_the_repo_and_frees_the_collateral` |
| SC-A13-03 | a repo of 60 | the CB repays 60 | the bank is debited | A13, S6 | 0011 | `unit::credit::the_central_bank_may_repay_on_the_banks_behalf` |
| SC-A13-04 | a repo of 60 | another bank repays | `NotAuthorized` | S6 | 0011 | `unit::credit::a_third_party_cannot_repay`, `auth::an_authorized_third_party_is_still_not_authorized_to_repay` |
| SC-A13-05 | outstanding 60 | repay 61; after repaying, repay 1 | `RepayExceedsRepo` | A13 | 0011 | `unit::credit::repaying_more_than_is_outstanding_is_refused` |
| SC-A13-06 | repo 60, then 50 paid away | repay 11; repay 10 | `InsufficientFunds`; then allowed | A13, S2 | 0011 | `unit::credit::a_bank_cannot_repay_more_than_its_balance` |
| SC-A13-07 | a repo | repay 0 or less | `InvalidAmount` | A13 | 0011 | `unit::credit::a_zero_or_negative_repayment_is_refused` |
| SC-A13-08 | — | repay an unknown repo | `UnknownRepo` | — | 0011 | `unit::credit::repaying_an_unknown_repo_is_refused` |
| SC-A13-09 | a repo | repay by the bank, by the CB; with no or the wrong authorization | the actor's tree only, the burn self-authorized; otherwise it fails and nothing is burned | S6 | 0011 | `auth::repay_is_authorized_by_the_actor_alone`, `auth::repay_by_the_central_bank_is_authorized_by_the_central_bank_alone`, `auth::repay_without_the_actors_authorization_fails` |

## A15 `Mint`, A16 `Burn`

Covered through the SAC. The issuer's mint happens inside `open_repo` (SC-A12-01, SC-A12-07), and the contract's burn inside `repay` (SC-A13-01, SC-A20-07). Deposit and withdraw move existing money between a bank's two accounts (A11, SC-A11), so they are neither. Clawback never undoes a final payment (ADR-0006). It is an issuer power outside the contract, and the integration layer tests it.

## A17 `Open`, A18 `Close`

Not applicable: there is no business day (ADR-0013). A18's rejection of unsettled payments becomes expiry (A5, ADR-0015). Its conversion of unpaid credit becomes the per-repo penalty step (below, ADR-0014).

## A19 `Tick`

This is the ledger's close time, set in tests with `env.ledger().set_timestamp`. The expiry and term tests (SC-A05, SC-A20) use it.

## A20 `RepayOvernight`: the penalty repo (ADR-0014)

The penalty rate is recorded but not charged, so conversion mints and burns nothing. This was decided with the user on 2026-10-24.

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-A20-01 | a repo opened at t, 20 repaid | convert at t + term + 1 | `Penalty`, rate 500 bps; cr 0, ovn 40; nothing minted or burned; `RepoPenalised` | S21 | 0014 | `unit::credit::an_overdue_repo_becomes_a_penalty_repo` |
| SC-A20-02 | a repo opened at t | convert at t and at t + term | `NotOverdue` | — | 0014 | `unit::credit::a_repo_exactly_at_its_term_is_not_overdue` |
| SC-A20-03 | term 10 s, rate 1,234 bps | convert at +11 | rate 1,234 recorded | — | 0014 | `unit::credit::the_term_and_the_penalty_rate_are_configurable` |
| SC-A20-04 | a penalty repo | convert again | `AlreadyPenalty` | — | 0014 | `unit::credit::a_penalty_repo_cannot_be_converted_again` |
| SC-A20-05 | a repaid repo | convert after its term | `NotOverdue` | — | 0014 | `unit::credit::a_repaid_repo_is_never_overdue` |
| SC-A20-06 | — | convert an unknown repo | `UnknownRepo` | — | 0014 | `unit::credit::converting_an_unknown_repo_is_refused` |
| SC-A20-07 | a penalty repo of 60 | repay 25, then 35 | ovn 35, then 0; `Repaid`; burned | A20, S1, S4 | 0014 | `unit::credit::a_penalty_repo_is_repaid_by_a_burn` |
| SC-A20-08 | ovn 60, collateral 100 | repo 41, repo 40, collateral 99 | refused, allowed, refused | S21 | 0014 | `unit::credit::penalty_repos_stay_collateralised` |
| SC-A20-09 | no authorization | convert after the term | succeeds; no auths recorded | S6 | 0014 | `auth::convert_overdue_needs_no_authorization` |

## Storage lifetime and cost

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-ST-01 | ledger 1,000 | a deposit | the instance and the balance live until 1,000 + `BUMP_AMOUNT` (about 30 days) | — | 0004 | `unit::storage::a_deposit_extends_the_instance_and_the_balance_to_thirty_days` |
| SC-ST-02 | a deposit at ledger 1,000 | deposits at 1,001, then once the TTL is below `BUMP_THRESHOLD` | unchanged, then extended from the later ledger | — | 0004 | `unit::storage::an_entry_is_extended_again_only_below_the_threshold` |
| SC-ST-03 | one ledger | every state-changing entry point | every entry the contract owns lives `BUMP_AMOUNT` ledgers | — | 0004 | `unit::storage::every_entry_point_extends_every_entry_it_writes` |
| SC-ST-04 | the contract from Wasm, `queue_cap` = 64, a ring of 64 banks, all queued, bank 0 short 1 | bank 0 deposits 1 | one offset settles all 64 within Mainnet's per-transaction limits | A3, S23 | 0010 | `unit::storage::an_offset_over_a_full_queue_fits_in_one_transaction` |

The 64 of SC-ST-04 is provisional. ADR-0010 sizes the cap from ADR-0007's target (OQ-29, OQ-30), and C-SC-204 puts the ceiling at about 66.

## Linked groups (F5, S16, S19)

Not in v1: κ-proto has no groups. ADR-0010's eager group settlement waits for the definition's revision.

## Properties over many inputs

The property tests check a rule over generated inputs rather than one example (TESTING.md §2). CI runs them with a pinned seed; set `PROPTEST_RNG_SEED` and `PROPTEST_CASES` to explore further.

The state machine `state_machine::the_contract_refines_the_reference_model` replays random sequences of every entry point against a reference model of §4 under the ADRs, comparing each outcome and the whole state. It covers the state changes and error outcomes of A1, A2, A3, A5, A6, A8, A11 to A14, A19 and A20, the actions of SC-P-02's Model IDs, for positive amounts of 1 to 300, the exact or one-over holdings, balances and collateral headroom, the exact repo amounts, and payments past their expiry and repos past their term. It does not cover:
- events;
- authorization: every auth is mocked, so the `auth::` tests alone cover S6;
- zero, negative or `i128`-extreme amounts, which SC-P-01 sends;
- the queue cap, which SC-P-01 covers;
- deauthorized holders (SC-A11-15, SC-A11-16).

**Expiry as `quint/settlement.qnt` has it (ADR-0015, provisional).** Only `expire` expires a payment. A payment past its expiry stays queued, keeps blocking its queue, and can still settle or be revoked until `expire` is called. The Quint model states this, and its replay (SC-MB-01) already pins it; the model of SC-P-02 and SC-P-01's at-rest check assume it too. ADR-0015 also lets any call that meets an expired head reject it, and S12's τ_rej would forbid settling after the expiry. Whether v1 should do either is still a decision for the user (README). If it should, change `settlement.qnt`, the state machine's `settle` and `expire`, and SC-P-01's at-rest check together.

**Two requirements SC-P-01 states.** An offset books each bank's net change, computed exactly, for example with the 64-bit split of `reference::net_is_non_negative`. By S1 every end balance fits in `i128`, but neither booking payment by payment nor applying every debit first stays in range: both overflow at the `i128` limit. SC-A03-11 and SC-A03-12 pin this too. A refused SAC call, such as an `open_repo` mint that would overflow the contract's holding, comes back as a contract error, not a host abort.

**One requirement only SC-P-02 states.** Where an input breaks several guards at once, the error is the first of: unknown id, then final status, then the specific guard. `quint/settlement.qnt`, and so SC-MB-01, already fix this order for `reprioritise` (`UnknownPayment`, `NotQueued`, `SamePriority`) and `expire` (`UnknownPayment`, `NotQueued`, `NotExpired`). SC-P-02 adds `repay`'s: `UnknownRepo`, `NotAuthorized`, `RepayExceedsRepo`, `InsufficientFunds`. The unit tests leave the order open.

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-P-01 | 3 banks with 1,000 tokens and 1,000 collateral each, `queue_cap` 6, expiry and term 100 s | any sequence of calls, with zero, negative, exact, one-over and `i128` extreme amounts, unknown ids and time steps | every failure is a contract error; after each call: tokens held = Σ balances = net deposits + repos − repayments; no negative balance; final payments unchanged; settled payments precede, in `≺`, every payment their sender still queues; payments valid; queue views match statuses, under the cap; k* = 0; `cr + ovn ≤ coll` and they match the repos | S1, S2, S3, S5, S7, S9, S11, S17, S21, S23 | 0004–0006, 0008–0011, 0013–0016, 0018 | `props::the_safety_invariants_hold_for_any_call_sequence` |
| SC-P-02 | 3 banks with 500 tokens each, `queue_cap` 1,000 (never reached), expiry and term 100 s | random call sequences | the contract matches the reference model call by call: outcome, balances, holdings, queues, payments, repos, credit | A1–A3, A5, A6, A8, A11–A14, A19, A20; S1–S5, S7, S9–S11, S13, S17, S21, S23; R4, R6 | 0004, 0005, 0008–0011, 0013–0018 | `state_machine::the_contract_refines_the_reference_model` |
| SC-P-03 | any balance and amount in `i128` | `covers` | true exactly when balance ≥ amount, with no overflow | A2 guard `cov`, S2 | 0011, 0018 | `core::props::covers_is_exactly_balance_at_least_amount` |
| SC-P-04 | 2–4 accounts, up to 3 candidates each | the prefix rule | k* is within every queue, feasible (F1), and the join of every feasible prefix vector, found by enumeration | R4, S10 | 0010 | `core::props::the_prefix_is_within_every_queue`, `core::props::the_prefix_is_feasible`, `core::props::the_prefix_is_the_greatest_feasible_one` |
| SC-P-05 | the same | relabel the accounts; raise a balance | k* relabels the same way; k* never shrinks | R4 | 0010 | `core::props::the_prefix_does_not_depend_on_the_account_order`, `core::props::more_liquidity_never_shrinks_the_prefix` |
| SC-P-06 | the same | FIFO gross processing alone; the offset of k*, then the rule again | `k_seq ≤ k*`; nothing more is feasible | R5, R6, S23 | 0010 | `core::props::gross_processing_never_beats_the_offset`, `core::props::after_the_offset_nothing_more_is_feasible` |
| SC-P-07 | a head larger than its bank's balance plus every inflow | the prefix rule | that bank's prefix is 0: no overtaking | F2, S7 | 0008, 0010 | `core::props::a_candidate_no_inflow_can_cover_blocks_its_queue` |
| SC-P-08 | amounts at the `i128` limit | the prefix rule | no panic; F1 is decided exactly, though the sums exceed `i128`; k* is still the greatest feasible prefix | R4, S2, S10 | 0010 | `core::props::sums_beyond_i128_are_decided_exactly_not_a_panic` |
| SC-P-09 | 2–4 accounts, up to 3 candidates each, amounts up to `i128::MAX`; R7's cycle; a cascade of drops; SC-A03-11's sums beyond `i128` | the reference descent that judges SC-P-01 and SC-P-02 | it is the join of every feasible prefix vector, found by enumeration; (1, 1, 1); nothing; (2, 1, 1) and (2, 1) | R4, R5, R7, F1 | 0010 | `reference::checks::the_reference_descent_is_the_greatest_feasible_prefix`, `reference::checks::the_reference_descent_resolves_r7_and_cascades` |

## Model-based: Quint traces replayed (TESTING.md §3)

`quint/settlement.qnt` is the oracle. Its header lists where it departs from `rtgs.qnt`: no business day, expiry instead of cut-offs, a queue cap, and no credit yet (ADR-0013 to ADR-0018). The `qnt::…` runs pin the oracle to the catalogue rows named in brackets. The 50 committed traces then judge the contract step by step. The outcome, the balances and cash held, both queues of every bank and every payment record must match exactly. The `Offset` and `Settled` events must match as a multiset, with the offsets in the model's order and each before its own settlements. The order in which banks are settled is left to the contract (R2).

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-MB-01 | three banks, each holding 500 outside | 30 random calls of deposit, withdraw, submit, revoke, reprioritise, expire and tick, ×50 traces | every step matches the model's outcome and state exactly, and its events up to the bank order | A1, A2, A3, A5, A6, A8, A19, S1, S2, S3, S5, S7, S9, S11, S23, R2 | 0008, 0009, 0010, 0015, 0016 | `itf_replay::quint_traces_replay_against_the_contract`, `itf_replay::settlement_events_match_as_a_set_with_each_offset_before_its_own_settlements` |
| SC-MB-02 | the committed traces | decode them | every step is a call the replay knows; each offset is ascending, with ≥ 2 payments; the traces reach an offset, ≥ 4 queued, a call settling ≥ 3, an urgent payment past an older normal one, and every error the modelled calls return; self-payments are at most an eighth of the submissions | A3, S7(a), S9 | 0009, 0010 | `itf_replay::quint_traces_decode_and_cover_the_paths_the_replay_checks` |
| SC-MB-03 | the model | 2,000 random runs of 30 steps | S1, S2, S3, S5, S7, S9, S11, S23 and the queue cap hold; `make quint` fails if any witness is unreached | S1–S3, S5, S7, S9, S11, S23 | 0004, 0008, 0010 | `make quint` |
| SC-MB-04 | the model | the scenarios of the catalogue | as in the rows [SC-A01-01, -09, -13, -15; SC-A02-05, -07; SC-A03-01, -03, -04, -05, -06; SC-A05-02, -04; SC-A06-02, -07; SC-A08-01, -03, -05; SC-F-04, -08] | A1–A3, A5, A6, A8, R4, R7 | 0008–0010, 0015, 0016 | `qnt::coveredPaymentSettlesAtOnceTest`, `qnt::queueCapTest`, `qnt::urgentSettlesAheadOfNormalTest`, `qnt::cpssBox4StrictFifoTest`, `qnt::cascadeTest`, `qnt::settledPaymentNeverChangesTest`, `qnt::r7GridlockTest`, `qnt::greatestPrefixTest`, `qnt::noOvertakingTest`, `qnt::urgentFirstInPrefixTest`, `qnt::depositMakesOffsetFeasibleTest`, `qnt::expiringTheHeadReleasesTest`, `qnt::revocationHasNoCutOffTest`, `qnt::revokingTheHeadReleasesTest`, `qnt::promotionKeepsAgeTest`, `qnt::promotionSettlesTest`, `qnt::fundingErrorsTest` |
| SC-MB-05 | committed traces with one edited, one deleted or one extra | the stale check | each fails; matching sets pass | — | — | `scripts/check-traces-selftest.sh` (run by `make quint`) |

## Integration on the devnet (TESTING.md §4)

Each row runs under ADR-0003's issuer flags, with the bank trustlines and the contract authorized as holders. A11's guard `phase = Open` does not apply (ADR-0013).

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-IT-01 | banks B1 and B2 hold 1,000 each; the contract is an authorized holder | B1 deposits 100, then 200; B2 deposits 50 | each transaction is final (`SUCCESS`); `balance` = 300 and 50; the trustlines hold 700 and 950; the contract holds 350 = Σ balances; `deposited` events B1:100, B1:200, B2:50 in that order; stored `Balance(B1)` = 300; the TTL of `Balance(B1)` and of the instance is `BUMP_AMOUNT` from the first deposit | A11, S1, S4, S6 | 0003, 0004, 0005 | `integration/deposit.sh` |
| SC-IT-02 | B holds 1,000; another account A holds only its own key | A signs and submits `deposit(B, 1)` | simulation succeeds and needs B's authorization, and only B's; the network refuses the submitted transaction at B's `require_auth` (`Error(Auth, InvalidAction)`); nothing moves; A pays the fee and uses its sequence number | A11, S6 | 0004 | `integration/deposit-auth.sh` |
| SC-IT-03 | the issuer hasn't yet authorized the contract as a holder | B deposits 100 | `TokenTransferFailed` (`Error(Contract, #2)`); nothing moves; B's sequence number isn't used | A11, S1, S4 | 0003 | `integration/deposit-failures.sh` |
| SC-IT-04 | B's trustline holds 600 | B deposits 601 | `TokenTransferFailed` (`Error(Contract, #2)`), as in SC-A11-04; nothing moves; B's sequence number isn't used | A11, S1, S4 | 0003 | `integration/deposit-failures.sh` |
| SC-IT-05 | the issuer has frozen B's trustline | B deposits 100 | `TokenTransferFailed` (`Error(Contract, #2)`), as in SC-A11-15; `balance(B)` = 0 and S1 holds | A11, S1, S6 | 0003 | `integration/deposit-failures.sh` |
| SC-IT-06 | B holds 1,000 | B deposits 0, or −5 | `InvalidAmount` (`Error(Contract, #1)`), as in SC-A11-03, raised before the contract calls the SAC (simulation has no diagnostic event from the SAC); nothing moves; no `deposited` event | A11 (guard x > 0), S4 | 0004 | `integration/deposit-zero.sh` |

## Known hazards

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-H-01 | on the devnet: B has deposited 600 under ADR-0003's flags | the issuer claws back 100 straight from the contract through the SAC; then deauthorizes the contract | the contract holds 500 while `balance(B)` = 600, so **S1 is broken**; every later deposit fails. To be fixed by an issuance controller that refuses both (`rtgs-mapping.md` §2; review H1). SC-H-02 then replaces this row | S1, L1, L3 | 0003, 0006 | `integration/issuer-powers-hazard.sh` (**known hazard**) |
| SC-H-02 | the same, once an issuance controller holds the SAC admin role | the issuer submits a direct SAC clawback of 100 from the contract, then a direct freeze of it | the network refuses both (`Error(Auth, InvalidAction)`); S1 holds; a further deposit of 100 settles (700) | S1, L1, L3 | 0003, 0006 | `integration/pending/issuer-powers-refused.sh` (**pending**: today both succeed) |
