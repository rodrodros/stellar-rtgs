//! A1 `Submit` and A2 `Settle`: gross settlement, the two FIFO queues of each bank, and
//! the eager closure that settles every covered head in the transaction that covers it.
//!
//! The model's A1 guard also checks the phase and the value date. ADR-0013 removes both:
//! there is no business day, and a payment's value time is the ledger that settles it.
use soroban_sdk::testutils::Ledger as _;

use crate::tests::support::{default_config, Setup};
use crate::*;

const NORMAL: Priority = Priority::Normal;
const URGENT: Priority = Priority::Urgent;

// ---------------------------------------------------------------------------------------
// A1 with an immediate A2

/// SC-A01-01. A1 then A2: a covered payment settles at once, in the submitting
/// transaction, and its id is the first sequence number (S4, S11, L1 with δ = 0;
/// ADR-0005, ADR-0008).
#[test]
fn a_covered_payment_settles_at_once() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    setup.at(1_000);

    let id = client.submit(setup.bank(0), setup.bank(1), &40, &NORMAL);

    assert_eq!(id, 0);
    assert_eq!(
        setup.our_events(),
        std::vec![
            setup.ev(Submitted {
                id,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 40,
                priority: NORMAL,
            }),
            setup.ev(Settled {
                id,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 40,
            }),
        ]
    );
    // S4: the balances change by exactly the settled amount; no tokens move (S1).
    assert_eq!(setup.balances(), std::vec![60, 40]);
    assert_eq!(setup.token().balance(&setup.contract), 100);
    assert_eq!(
        client.payment(&id),
        Some(Payment {
            id,
            from: setup.bank(0).clone(),
            to: setup.bank(1).clone(),
            amount: 40,
            priority: NORMAL,
            submitted_at: 1_000,
            status: Status::Settled,
            settled_at: Some(1_000),
        })
    );
    assert_eq!(client.queued_count(), 0);
    setup.assert_conserved();
}

/// SC-A01-02. A payment of exactly the sender's balance is covered (§4.5 `cov` with
/// `lim` = 0, ADR-0011), and leaves the sender at 0 (S2).
#[test]
fn a_payment_of_exactly_the_balance_settles() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &100, &URGENT);
    assert_eq!(client.payment(&id).unwrap().status, Status::Settled);
    assert_eq!(setup.balances(), std::vec![0, 100]);
    setup.assert_conserved();
}

/// SC-A01-03. A payment of one more than the balance is not covered and waits in its
/// priority's queue; nothing moves (S2, S4; ADR-0008).
#[test]
fn a_payment_of_one_more_than_the_balance_is_queued() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    setup.at(7);

    let id = client.submit(setup.bank(0), setup.bank(1), &101, &NORMAL);

    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(Submitted {
            id,
            from: setup.bank(0).clone(),
            to: setup.bank(1).clone(),
            amount: 101,
            priority: NORMAL,
        })]
    );
    let payment = client.payment(&id).unwrap();
    assert_eq!(payment.status, Status::Queued);
    assert_eq!(payment.submitted_at, 7);
    assert_eq!(payment.settled_at, None);
    assert_eq!(setup.queue(0, NORMAL), std::vec![id]);
    assert!(setup.queue(0, URGENT).is_empty());
    assert_eq!(client.queued_count(), 1);
    assert_eq!(setup.balances(), std::vec![100, 0]);
    setup.assert_conserved();
}

/// SC-A01-04. A bank with no settlement balance can still submit; its payment queues.
#[test]
fn a_bank_with_no_balance_can_queue_a_payment() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &1, &NORMAL);
    assert_eq!(setup.queue(0, NORMAL), std::vec![id]);
}

/// SC-A01-05. Order amounts are positive (§4.1, A1 guard): zero and negative amounts are
/// refused with `InvalidAmount`, and no id is used (S11).
#[test]
fn a_zero_or_negative_payment_is_refused() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    for amount in [0, -1, i128::MIN] {
        assert_eq!(
            client.try_submit(setup.bank(0), setup.bank(1), &amount, &NORMAL),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(client.submit(setup.bank(0), setup.bank(1), &1, &NORMAL), 0);
    assert_eq!(setup.balances(), std::vec![99, 1]);
}

/// SC-A01-06. A1 guard `s ≠ r`: a payment to oneself is refused with `SameAccount`.
#[test]
fn a_payment_to_oneself_is_refused() {
    let setup = Setup::funded(&[100]);
    let client = setup.client();
    assert_eq!(
        client.try_submit(setup.bank(0), setup.bank(0), &10, &NORMAL),
        Err(Ok(Error::SameAccount))
    );
    assert_eq!(client.balance(setup.bank(0)), 100);
    assert_eq!(client.queued_count(), 0);
}

/// SC-A01-07. `i128::MAX`: a payment of the largest amount is accepted. Uncovered, it
/// queues; covered, it settles, and the receiver's sum cannot overflow because S1 bounds
/// every balance by the tokens held.
#[test]
fn a_payment_of_i128_max_queues_or_settles_without_overflow() {
    let setup = Setup::new(3, 0);
    let client = setup.client();
    let queued = client.submit(setup.bank(2), setup.bank(1), &i128::MAX, &NORMAL);
    assert_eq!(client.payment(&queued).unwrap().status, Status::Queued);

    setup.mint(setup.bank(0), i128::MAX);
    client.deposit(setup.bank(0), &i128::MAX);
    let settled = client.submit(setup.bank(0), setup.bank(1), &i128::MAX, &URGENT);
    assert_eq!(client.payment(&settled).unwrap().status, Status::Settled);
    assert_eq!(client.balance(setup.bank(1)), i128::MAX);
    setup.assert_conserved();
}

/// SC-A01-08. S11: ids are sequence numbers, distinct and increasing across banks and
/// priorities, whether the payment settles or queues.
#[test]
fn ids_are_increasing_sequence_numbers() {
    let setup = Setup::funded(&[100, 0, 0]);
    let client = setup.client();
    let ids = [
        client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL),
        client.submit(setup.bank(1), setup.bank(2), &500, &URGENT),
        client.submit(setup.bank(2), setup.bank(0), &500, &NORMAL),
        client.submit(setup.bank(0), setup.bank(2), &10, &URGENT),
    ];
    assert_eq!(ids, [0, 1, 2, 3]);
    assert_eq!(client.payment(&4), None);
}

/// SC-A01-09. A1, ADR-0010's queue cap: at `queue_cap` queued payments, another uncovered
/// payment is refused with `QueueFull`, but a covered one still settles, since it never
/// queues.
#[test]
fn the_queue_cap_refuses_only_payments_that_would_queue() {
    let setup = Setup::with_config(
        2,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let client = setup.client();
    setup.mint(setup.bank(1), 100);
    client.deposit(setup.bank(1), &100);
    client.submit(setup.bank(0), setup.bank(1), &500, &NORMAL);
    client.submit(setup.bank(0), setup.bank(1), &500, &URGENT);
    assert_eq!(client.queued_count(), 2);

    assert_eq!(
        client.try_submit(setup.bank(0), setup.bank(1), &500, &NORMAL),
        Err(Ok(Error::QueueFull))
    );
    assert_eq!(client.queued_count(), 2);
    assert_eq!(client.payment(&2), None);

    let id = client.submit(setup.bank(1), setup.bank(0), &100, &NORMAL);
    assert_eq!(id, 2);
    assert_eq!(client.payment(&id).unwrap().status, Status::Settled);
}

/// SC-A01-10. A1, ADR-0010: below the cap by one, an uncovered payment still queues.
#[test]
fn one_below_the_queue_cap_a_payment_still_queues() {
    let setup = Setup::with_config(
        2,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let client = setup.client();
    client.submit(setup.bank(0), setup.bank(1), &500, &NORMAL);
    client.submit(setup.bank(0), setup.bank(1), &500, &NORMAL);
    assert_eq!(client.queued_count(), 2);
    assert_eq!(setup.queue(0, NORMAL), std::vec![0, 1]);
}

/// SC-A01-22. A1, ADR-0010: the cap counts queued payments only. A payment that settled
/// does not count, so with a cap of 2 two payments still queue after one has settled.
#[test]
fn a_settled_payment_does_not_count_toward_the_queue_cap() {
    let setup = Setup::with_config(
        2,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let client = setup.client();
    setup.mint(setup.bank(1), 100);
    client.deposit(setup.bank(1), &100);
    assert_eq!(client.submit(setup.bank(1), setup.bank(0), &10, &NORMAL), 0);
    assert_eq!(client.payment(&0).unwrap().status, Status::Settled);

    assert_eq!(
        client.submit(setup.bank(0), setup.bank(1), &500, &NORMAL),
        1
    );
    assert_eq!(
        client.submit(setup.bank(0), setup.bank(1), &500, &NORMAL),
        2
    );
    assert_eq!(client.queued_count(), 2);
}

/// SC-A01-18. A1, ADR-0010 with S7: at the cap, a covered payment that would wait behind the
/// sender's own queued payment would queue, so it is refused with `QueueFull` like an
/// uncovered one (`queueBounded`). The sender's queued urgent payments block both a normal
/// payment (S7(a)) and an urgent one (S7(b), ADR-0008, ADR-0009).
#[test]
fn at_the_queue_cap_a_covered_payment_blocked_by_the_senders_queue_is_refused() {
    let setup = Setup::with_config(
        2,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let client = setup.client();
    setup.mint(setup.bank(0), 100);
    client.deposit(setup.bank(0), &100);
    client.submit(setup.bank(0), setup.bank(1), &500, &URGENT);
    client.submit(setup.bank(0), setup.bank(1), &500, &URGENT);
    assert_eq!(client.queued_count(), 2);

    for priority in [NORMAL, URGENT] {
        assert_eq!(
            client.try_submit(setup.bank(0), setup.bank(1), &10, &priority),
            Err(Ok(Error::QueueFull))
        );
    }
    assert_eq!(client.queued_count(), 2);
    assert_eq!(setup.balances(), std::vec![100, 0]);
}

/// SC-A01-19. ADR-0010: the cap counts the queued payments of every bank, and applies to
/// either priority. Two banks fill it, so a third bank's uncovered urgent payment, with
/// nothing of its own queued, is refused with `QueueFull` (A1). The payment is more than
/// everything queued to its sender, so no offset could settle it either (F1): the test
/// holds whatever is decided about the cap and the offset (README).
#[test]
fn the_queue_cap_counts_every_banks_queue_and_refuses_an_urgent_payment_too() {
    let setup = Setup::with_config(
        3,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let client = setup.client();
    client.submit(setup.bank(0), setup.bank(2), &500, &NORMAL);
    client.submit(setup.bank(1), setup.bank(2), &500, &NORMAL);
    assert_eq!(client.queued_count(), 2);

    assert_eq!(
        client.try_submit(setup.bank(2), setup.bank(0), &1_001, &URGENT),
        Err(Ok(Error::QueueFull))
    );
    assert_eq!(client.queued_count(), 2);
    assert_eq!(client.payment(&2), None);

    setup.mint(setup.bank(2), 1);
    client.deposit(setup.bank(2), &1);
    assert_eq!(client.submit(setup.bank(2), setup.bank(0), &1, &URGENT), 2);
}

/// SC-A01-20. A1, S11, ADR-0010: at the cap, an invalid payment gets its own guard's
/// error, `InvalidAmount` or `SameAccount`, not `QueueFull`, and no id is used.
#[test]
fn at_the_queue_cap_a1s_guards_come_before_queue_full() {
    let setup = Setup::with_config(
        2,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let client = setup.client();
    client.submit(setup.bank(0), setup.bank(1), &500, &NORMAL);
    client.submit(setup.bank(0), setup.bank(1), &500, &NORMAL);
    assert_eq!(client.queued_count(), 2);

    assert_eq!(
        client.try_submit(setup.bank(0), setup.bank(1), &0, &NORMAL),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client.try_submit(setup.bank(0), setup.bank(0), &10, &NORMAL),
        Err(Ok(Error::SameAccount))
    );
    assert_eq!(client.queued_count(), 2);
    assert_eq!(client.payment(&2), None);
}

/// SC-A01-21. A1, S7(a), ADR-0009, ADR-0010: at the cap, a covered urgent payment from a
/// bank whose only queued payments are normal settles at once, so the cap does not refuse
/// it.
#[test]
fn at_the_queue_cap_a_covered_urgent_payment_settles_past_queued_normal_ones() {
    let setup = Setup::with_config(
        3,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let client = setup.client();
    setup.mint(setup.bank(0), 100);
    client.deposit(setup.bank(0), &100);
    client.submit(setup.bank(0), setup.bank(1), &500, &NORMAL);
    client.submit(setup.bank(2), setup.bank(1), &500, &NORMAL);
    assert_eq!(client.queued_count(), 2);

    let id = client.submit(setup.bank(0), setup.bank(1), &10, &URGENT);
    assert_eq!(client.payment(&id).unwrap().status, Status::Settled);
    assert_eq!(client.queued_count(), 2);
    assert_eq!(setup.balances(), std::vec![90, 10, 0]);
}

// ---------------------------------------------------------------------------------------
// Queue discipline: FIFO within each priority, urgent before normal

/// SC-A01-11. S7(b), ADR-0008: within a priority, a covered payment queues behind an
/// uncovered older one. Head-of-line blocking is the intended cost of strict FIFO.
#[test]
fn a_covered_payment_waits_behind_an_uncovered_one_of_the_same_priority() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let head = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    let behind = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    assert_eq!(setup.queue(0, NORMAL), std::vec![head, behind]);
    assert_eq!(client.payment(&behind).unwrap().status, Status::Queued);
    assert_eq!(setup.balances(), std::vec![50, 0]);
}

/// SC-A01-12. S7(a), ADR-0009: while a bank has an urgent payment queued, none of its
/// normal payments settles gross, even a covered one.
#[test]
fn a_queued_urgent_payment_blocks_the_banks_normal_payments() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let urgent = client.submit(setup.bank(0), setup.bank(1), &60, &URGENT);
    let normal = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    assert_eq!(setup.queue(0, URGENT), std::vec![urgent]);
    assert_eq!(setup.queue(0, NORMAL), std::vec![normal]);
    assert_eq!(setup.balances(), std::vec![50, 0]);
}

/// SC-A01-13. ADR-0009: an urgent payment goes ahead of the bank's queued normal ones,
/// and settles at once if covered.
#[test]
fn an_urgent_payment_settles_ahead_of_queued_normal_ones() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let normal = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    let urgent = client.submit(setup.bank(0), setup.bank(1), &10, &URGENT);
    assert_eq!(client.payment(&urgent).unwrap().status, Status::Settled);
    assert_eq!(setup.queue(0, NORMAL), std::vec![normal]);
    assert_eq!(setup.balances(), std::vec![40, 10]);
}

/// SC-A01-14. Queues are per bank: one bank's uncovered head never blocks another
/// bank's payments (§4.5: `≺` orders orders from the same account only).
#[test]
fn one_banks_blocked_queue_does_not_block_another_bank() {
    let setup = Setup::funded(&[0, 50, 0]);
    let client = setup.client();
    client.submit(setup.bank(0), setup.bank(2), &60, &URGENT);
    let other = client.submit(setup.bank(1), setup.bank(2), &50, &NORMAL);
    assert_eq!(client.payment(&other).unwrap().status, Status::Settled);
    assert_eq!(setup.balances(), std::vec![0, 0, 50]);
}

/// SC-A01-15. CPSS Box 4 (C-RT-045, §4.11): balance 100 and the queue 40, 70, 20, 30,
/// 10. Strict FIFO settles the 40 only, and the 70 holds up the rest (ADR-0008, S7).
/// Bypass would have settled four payments worth 100.
#[test]
fn cpss_box_4_strict_fifo_settles_only_the_first_payment() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    let ids: std::vec::Vec<u64> = [40, 70, 20, 30, 10]
        .iter()
        .map(|amount| client.submit(setup.bank(0), setup.bank(1), amount, &NORMAL))
        .collect();
    assert_eq!(client.payment(&ids[0]).unwrap().status, Status::Settled);
    assert_eq!(setup.queue(0, NORMAL), ids[1..].to_vec());
    assert_eq!(setup.balances(), std::vec![60, 40]);
    setup.assert_conserved();
}

/// SC-A01-17. S7(b), ADR-0008, ADR-0009: FIFO holds within the urgent priority too. A
/// covered urgent payment queues behind an uncovered older urgent one.
#[test]
fn a_covered_urgent_payment_waits_behind_an_uncovered_urgent_one() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let head = client.submit(setup.bank(0), setup.bank(1), &60, &URGENT);
    let behind = client.submit(setup.bank(0), setup.bank(1), &10, &URGENT);
    assert_eq!(setup.queue(0, URGENT), std::vec![head, behind]);
    assert_eq!(client.payment(&behind).unwrap().status, Status::Queued);
    assert_eq!(setup.balances(), std::vec![50, 0]);
}

// ---------------------------------------------------------------------------------------
// The eager closure: every covered head settles in the transaction that covers it

/// SC-A02-01. L1 with δ = 0 and S9 (ADR-0010's eager processing): a deposit that covers
/// a queued head settles it in the same transaction; `Settled` follows `Deposited`.
#[test]
fn a_deposit_that_covers_the_head_settles_it_in_the_same_call() {
    let setup = Setup::new(2, 30);
    let client = setup.client();
    setup.at(5);
    let id = client.submit(setup.bank(0), setup.bank(1), &30, &NORMAL);
    setup.at(9);

    client.deposit(setup.bank(0), &30);

    assert_eq!(
        setup.our_events(),
        std::vec![
            setup.ev(Deposited {
                bank: setup.bank(0).clone(),
                amount: 30,
            }),
            setup.ev(Settled {
                id,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 30,
            }),
        ]
    );
    let payment = client.payment(&id).unwrap();
    assert_eq!(payment.status, Status::Settled);
    assert_eq!(payment.settled_at, Some(9));
    assert_eq!(client.queued_count(), 0);
    assert_eq!(setup.balances(), std::vec![0, 30]);
    setup.assert_conserved();
}

/// SC-A02-02. S7, S9: new liquidity settles the queue in FIFO order and stops at the
/// first payment it does not cover.
#[test]
fn new_liquidity_settles_the_queue_in_order_up_to_the_first_uncovered_payment() {
    let setup = Setup::new(2, 60);
    let client = setup.client();
    let first = client.submit(setup.bank(0), setup.bank(1), &30, &NORMAL);
    let second = client.submit(setup.bank(0), setup.bank(1), &20, &NORMAL);
    let third = client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);

    client.deposit(setup.bank(0), &60);

    let settled: std::vec::Vec<u64> = [first, second, third]
        .into_iter()
        .filter(|id| client.payment(id).unwrap().status == Status::Settled)
        .collect();
    assert_eq!(settled, std::vec![first, second]);
    assert_eq!(setup.queue(0, NORMAL), std::vec![third]);
    assert_eq!(setup.balances(), std::vec![10, 50]);
}

/// SC-A02-03. ADR-0009 in the closure: the urgent queue empties before any normal
/// payment settles, whatever their ids.
#[test]
fn new_liquidity_settles_urgent_payments_before_normal_ones() {
    let setup = Setup::new(2, 30);
    let client = setup.client();
    let normal = client.submit(setup.bank(0), setup.bank(1), &20, &NORMAL);
    let urgent = client.submit(setup.bank(0), setup.bank(1), &20, &URGENT);

    client.deposit(setup.bank(0), &30);

    assert_eq!(client.payment(&urgent).unwrap().status, Status::Settled);
    assert_eq!(client.payment(&normal).unwrap().status, Status::Queued);
    assert_eq!(setup.balances(), std::vec![10, 20]);
}

/// SC-A02-04. The closure cascades (§4.6 eager closure, S9): a settlement that credits
/// another bank settles that bank's covered head too, in the same call.
#[test]
fn a_settlement_cascades_through_the_receivers_queue() {
    let setup = Setup::new(3, 30);
    let client = setup.client();
    let first = client.submit(setup.bank(0), setup.bank(1), &30, &NORMAL);
    let second = client.submit(setup.bank(1), setup.bank(2), &30, &URGENT);

    client.deposit(setup.bank(0), &30);

    assert_eq!(client.payment(&first).unwrap().status, Status::Settled);
    assert_eq!(client.payment(&second).unwrap().status, Status::Settled);
    assert_eq!(setup.balances(), std::vec![0, 0, 30]);
    assert_eq!(client.queued_count(), 0);
    setup.assert_conserved();
}

/// SC-A02-05. The cascade also runs from a submission: a payment that settles at once
/// covers the receiver's queued head, and both settle in the submitting call, the new
/// payment first.
#[test]
fn a_submission_that_settles_releases_the_receivers_queue() {
    let setup = Setup::funded(&[30, 0, 0]);
    let client = setup.client();
    let waiting = client.submit(setup.bank(1), setup.bank(2), &30, &NORMAL);

    let id = client.submit(setup.bank(0), setup.bank(1), &30, &NORMAL);

    assert_eq!(
        setup.our_events(),
        std::vec![
            setup.ev(Submitted {
                id,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 30,
                priority: NORMAL,
            }),
            setup.ev(Settled {
                id,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 30,
            }),
            setup.ev(Settled {
                id: waiting,
                from: setup.bank(1).clone(),
                to: setup.bank(2).clone(),
                amount: 30,
            }),
        ]
    );
    assert_eq!(setup.balances(), std::vec![0, 0, 30]);
}

/// SC-A02-06. A withdrawal never settles anything (it only lowers a balance), and the
/// closure leaves the queue at rest (S9).
#[test]
fn a_withdrawal_settles_nothing() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    client.withdraw(setup.bank(0), &10);
    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(Withdrawn {
            bank: setup.bank(0).clone(),
            amount: 10,
        })]
    );
    assert_eq!(client.payment(&id).unwrap().status, Status::Queued);
}

/// S3, S5: once settled, a payment's record never changes, whatever happens later.
#[test]
fn a_settled_payment_never_changes() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    setup.at(3);
    let id = client.submit(setup.bank(0), setup.bank(1), &40, &NORMAL);
    let before = client.payment(&id).unwrap();

    setup.env.ledger().set_timestamp(10_000_000);
    client.submit(setup.bank(1), setup.bank(0), &40, &NORMAL);
    client.withdraw(setup.bank(0), &100);

    assert_eq!(client.payment(&id).unwrap(), before);
}
