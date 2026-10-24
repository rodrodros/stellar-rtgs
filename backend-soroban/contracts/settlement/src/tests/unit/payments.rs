//! A1 `Submit` and A2 `Settle`: gross settlement, the two FIFO queues of each bank, and
//! the eager closure that settles every covered head in the transaction that covers it.
//!
//! The model's A1 guard also checks the phase and the value date. ADR-0013 removes both:
//! there is no business day, and a payment's value time is the ledger that settles it.
use soroban_sdk::testutils::Ledger as _;

use crate::tests::support::{default_config, Setup};
use crate::*;

const N: Priority = Priority::Normal;
const U: Priority = Priority::Urgent;

// ---------------------------------------------------------------------------------------
// A1 with an immediate A2

/// SC-A01-01. A1 then A2: a covered payment settles at once, in the submitting
/// transaction, and its id is the first sequence number (S4, S11, L1 with δ = 0;
/// ADR-0005, ADR-0008).
#[test]
fn a_covered_payment_settles_at_once() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    s.at(1_000);

    let id = c.submit(s.bank(0), s.bank(1), &40, &N);

    assert_eq!(id, 0);
    assert_eq!(
        s.our_events(),
        std::vec![
            s.ev(Submitted {
                id,
                from: s.bank(0).clone(),
                to: s.bank(1).clone(),
                amount: 40,
                priority: N,
            }),
            s.ev(Settled {
                id,
                from: s.bank(0).clone(),
                to: s.bank(1).clone(),
                amount: 40,
            }),
        ]
    );
    // S4: the balances change by exactly the settled amount; no tokens move (S1).
    assert_eq!(s.balances(), std::vec![60, 40]);
    assert_eq!(s.token().balance(&s.contract), 100);
    assert_eq!(
        c.payment(&id),
        Some(Payment {
            id,
            from: s.bank(0).clone(),
            to: s.bank(1).clone(),
            amount: 40,
            priority: N,
            submitted_at: 1_000,
            status: Status::Settled,
            settled_at: Some(1_000),
        })
    );
    assert_eq!(c.queued_count(), 0);
    s.assert_conserved();
}

/// SC-A01-02. A payment of exactly the sender's balance is covered (§4.5 `cov` with
/// `lim` = 0, ADR-0011), and leaves the sender at 0 (S2).
#[test]
fn a_payment_of_exactly_the_balance_settles() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &100, &U);
    assert_eq!(c.payment(&id).unwrap().status, Status::Settled);
    assert_eq!(s.balances(), std::vec![0, 100]);
    s.assert_conserved();
}

/// SC-A01-03. A payment of one more than the balance is not covered and waits in its
/// priority's queue; nothing moves (S2, S4; ADR-0008).
#[test]
fn a_payment_of_one_more_than_the_balance_is_queued() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    s.at(7);

    let id = c.submit(s.bank(0), s.bank(1), &101, &N);

    assert_eq!(
        s.our_events(),
        std::vec![s.ev(Submitted {
            id,
            from: s.bank(0).clone(),
            to: s.bank(1).clone(),
            amount: 101,
            priority: N,
        })]
    );
    let p = c.payment(&id).unwrap();
    assert_eq!(p.status, Status::Queued);
    assert_eq!(p.submitted_at, 7);
    assert_eq!(p.settled_at, None);
    assert_eq!(s.queue(0, N), std::vec![id]);
    assert!(s.queue(0, U).is_empty());
    assert_eq!(c.queued_count(), 1);
    assert_eq!(s.balances(), std::vec![100, 0]);
    s.assert_conserved();
}

/// SC-A01-04. A bank with no settlement balance can still submit; its payment queues.
#[test]
fn a_bank_with_no_balance_can_queue_a_payment() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &1, &N);
    assert_eq!(s.queue(0, N), std::vec![id]);
}

/// SC-A01-05. Order amounts are positive (§4.1, A1 guard): zero and negative amounts are
/// refused with `InvalidAmount`, and no id is used (S11).
#[test]
fn a_zero_or_negative_payment_is_refused() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    for amount in [0, -1, i128::MIN] {
        assert_eq!(
            c.try_submit(s.bank(0), s.bank(1), &amount, &N),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(c.submit(s.bank(0), s.bank(1), &1, &N), 0);
    assert_eq!(s.balances(), std::vec![99, 1]);
}

/// SC-A01-06. A1 guard `s ≠ r`: a payment to oneself is refused with `SameAccount`.
#[test]
fn a_payment_to_oneself_is_refused() {
    let s = Setup::funded(&[100]);
    let c = s.client();
    assert_eq!(
        c.try_submit(s.bank(0), s.bank(0), &10, &N),
        Err(Ok(Error::SameAccount))
    );
    assert_eq!(c.balance(s.bank(0)), 100);
    assert_eq!(c.queued_count(), 0);
}

/// SC-A01-07. `i128::MAX`: a payment of the largest amount is accepted. Uncovered, it
/// queues; covered, it settles, and the receiver's sum cannot overflow because S1 bounds
/// every balance by the tokens held.
#[test]
fn a_payment_of_i128_max_queues_or_settles_without_overflow() {
    let s = Setup::new(3, 0);
    let c = s.client();
    let queued = c.submit(s.bank(2), s.bank(1), &i128::MAX, &N);
    assert_eq!(c.payment(&queued).unwrap().status, Status::Queued);

    s.mint(s.bank(0), i128::MAX);
    c.deposit(s.bank(0), &i128::MAX);
    let settled = c.submit(s.bank(0), s.bank(1), &i128::MAX, &U);
    assert_eq!(c.payment(&settled).unwrap().status, Status::Settled);
    assert_eq!(c.balance(s.bank(1)), i128::MAX);
    s.assert_conserved();
}

/// SC-A01-08. S11: ids are sequence numbers, distinct and increasing across banks and
/// priorities, whether the payment settles or queues.
#[test]
fn ids_are_increasing_sequence_numbers() {
    let s = Setup::funded(&[100, 0, 0]);
    let c = s.client();
    let ids = [
        c.submit(s.bank(0), s.bank(1), &10, &N),
        c.submit(s.bank(1), s.bank(2), &500, &U),
        c.submit(s.bank(2), s.bank(0), &500, &N),
        c.submit(s.bank(0), s.bank(2), &10, &U),
    ];
    assert_eq!(ids, [0, 1, 2, 3]);
    assert_eq!(c.payment(&4), None);
}

/// SC-A01-09. ADR-0010's queue cap: at `queue_cap` queued payments, another uncovered
/// payment is refused with `QueueFull`, but a covered one still settles, since it never
/// queues.
#[test]
fn the_queue_cap_refuses_only_payments_that_would_queue() {
    let s = Setup::with_config(
        2,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let c = s.client();
    s.mint(s.bank(1), 100);
    c.deposit(s.bank(1), &100);
    c.submit(s.bank(0), s.bank(1), &500, &N);
    c.submit(s.bank(0), s.bank(1), &500, &U);
    assert_eq!(c.queued_count(), 2);

    assert_eq!(
        c.try_submit(s.bank(0), s.bank(1), &500, &N),
        Err(Ok(Error::QueueFull))
    );
    assert_eq!(c.queued_count(), 2);

    let id = c.submit(s.bank(1), s.bank(0), &100, &N);
    assert_eq!(c.payment(&id).unwrap().status, Status::Settled);
}

/// SC-A01-10. Below the cap by one, an uncovered payment still queues.
#[test]
fn one_below_the_queue_cap_a_payment_still_queues() {
    let s = Setup::with_config(
        2,
        0,
        Config {
            queue_cap: 2,
            ..default_config()
        },
    );
    let c = s.client();
    c.submit(s.bank(0), s.bank(1), &500, &N);
    c.submit(s.bank(0), s.bank(1), &500, &N);
    assert_eq!(c.queued_count(), 2);
    assert_eq!(s.queue(0, N), std::vec![0, 1]);
}

// ---------------------------------------------------------------------------------------
// Queue discipline: FIFO within each priority, urgent before normal

/// SC-A01-11. S7(b), ADR-0008: within a priority, a covered payment queues behind an
/// uncovered older one. Head-of-line blocking is the intended cost of strict FIFO.
#[test]
fn a_covered_payment_waits_behind_an_uncovered_one_of_the_same_priority() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let head = c.submit(s.bank(0), s.bank(1), &60, &N);
    let behind = c.submit(s.bank(0), s.bank(1), &10, &N);
    assert_eq!(s.queue(0, N), std::vec![head, behind]);
    assert_eq!(c.payment(&behind).unwrap().status, Status::Queued);
    assert_eq!(s.balances(), std::vec![50, 0]);
}

/// SC-A01-12. S7(a), ADR-0009: while a bank has an urgent payment queued, none of its
/// normal payments settles gross, even a covered one.
#[test]
fn a_queued_urgent_payment_blocks_the_banks_normal_payments() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let urgent = c.submit(s.bank(0), s.bank(1), &60, &U);
    let normal = c.submit(s.bank(0), s.bank(1), &10, &N);
    assert_eq!(s.queue(0, U), std::vec![urgent]);
    assert_eq!(s.queue(0, N), std::vec![normal]);
    assert_eq!(s.balances(), std::vec![50, 0]);
}

/// SC-A01-13. ADR-0009: an urgent payment goes ahead of the bank's queued normal ones,
/// and settles at once if covered.
#[test]
fn an_urgent_payment_settles_ahead_of_queued_normal_ones() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let normal = c.submit(s.bank(0), s.bank(1), &60, &N);
    let urgent = c.submit(s.bank(0), s.bank(1), &10, &U);
    assert_eq!(c.payment(&urgent).unwrap().status, Status::Settled);
    assert_eq!(s.queue(0, N), std::vec![normal]);
    assert_eq!(s.balances(), std::vec![40, 10]);
}

/// SC-A01-14. Queues are per bank: one bank's uncovered head never blocks another
/// bank's payments (§4.5: `≺` orders orders from the same account only).
#[test]
fn one_banks_blocked_queue_does_not_block_another_bank() {
    let s = Setup::funded(&[0, 50, 0]);
    let c = s.client();
    c.submit(s.bank(0), s.bank(2), &60, &U);
    let other = c.submit(s.bank(1), s.bank(2), &50, &N);
    assert_eq!(c.payment(&other).unwrap().status, Status::Settled);
    assert_eq!(s.balances(), std::vec![0, 0, 50]);
}

/// SC-A01-15. CPSS Box 4 (C-RT-045, §4.11): balance 100 and the queue 40, 70, 20, 30,
/// 10. Strict FIFO settles the 40 only, and the 70 holds up the rest (ADR-0008, S7).
/// Bypass would have settled four payments worth 100.
#[test]
fn cpss_box_4_strict_fifo_settles_only_the_first_payment() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    let ids: std::vec::Vec<u64> = [40, 70, 20, 30, 10]
        .iter()
        .map(|a| c.submit(s.bank(0), s.bank(1), a, &N))
        .collect();
    assert_eq!(c.payment(&ids[0]).unwrap().status, Status::Settled);
    assert_eq!(s.queue(0, N), ids[1..].to_vec());
    assert_eq!(s.balances(), std::vec![60, 40]);
    s.assert_conserved();
}

// ---------------------------------------------------------------------------------------
// The eager closure: every covered head settles in the transaction that covers it

/// SC-A02-01. L1 with δ = 0 and S9 (ADR-0010's eager processing): a deposit that covers
/// a queued head settles it in the same transaction; `Settled` follows `Deposited`.
#[test]
fn a_deposit_that_covers_the_head_settles_it_in_the_same_call() {
    let s = Setup::new(2, 30);
    let c = s.client();
    s.at(5);
    let id = c.submit(s.bank(0), s.bank(1), &30, &N);
    s.at(9);

    c.deposit(s.bank(0), &30);

    assert_eq!(
        s.our_events(),
        std::vec![
            s.ev(Deposited {
                bank: s.bank(0).clone(),
                amount: 30,
            }),
            s.ev(Settled {
                id,
                from: s.bank(0).clone(),
                to: s.bank(1).clone(),
                amount: 30,
            }),
        ]
    );
    let p = c.payment(&id).unwrap();
    assert_eq!(p.status, Status::Settled);
    assert_eq!(p.settled_at, Some(9));
    assert_eq!(c.queued_count(), 0);
    assert_eq!(s.balances(), std::vec![0, 30]);
    s.assert_conserved();
}

/// SC-A02-02. S7, S9: new liquidity settles the queue in FIFO order and stops at the
/// first payment it does not cover.
#[test]
fn new_liquidity_settles_the_queue_in_order_up_to_the_first_uncovered_payment() {
    let s = Setup::new(2, 60);
    let c = s.client();
    let a = c.submit(s.bank(0), s.bank(1), &30, &N);
    let b = c.submit(s.bank(0), s.bank(1), &20, &N);
    let d = c.submit(s.bank(0), s.bank(1), &50, &N);

    c.deposit(s.bank(0), &60);

    let settled: std::vec::Vec<u64> = [a, b, d]
        .into_iter()
        .filter(|id| c.payment(id).unwrap().status == Status::Settled)
        .collect();
    assert_eq!(settled, std::vec![a, b]);
    assert_eq!(s.queue(0, N), std::vec![d]);
    assert_eq!(s.balances(), std::vec![10, 50]);
}

/// SC-A02-03. ADR-0009 in the closure: the urgent queue empties before any normal
/// payment settles, whatever their ids.
#[test]
fn new_liquidity_settles_urgent_payments_before_normal_ones() {
    let s = Setup::new(2, 30);
    let c = s.client();
    let normal = c.submit(s.bank(0), s.bank(1), &20, &N);
    let urgent = c.submit(s.bank(0), s.bank(1), &20, &U);

    c.deposit(s.bank(0), &30);

    assert_eq!(c.payment(&urgent).unwrap().status, Status::Settled);
    assert_eq!(c.payment(&normal).unwrap().status, Status::Queued);
    assert_eq!(s.balances(), std::vec![10, 20]);
}

/// SC-A02-04. The closure cascades (§4.6 eager closure, S9): a settlement that credits
/// another bank settles that bank's covered head too, in the same call.
#[test]
fn a_settlement_cascades_through_the_receivers_queue() {
    let s = Setup::new(3, 30);
    let c = s.client();
    let first = c.submit(s.bank(0), s.bank(1), &30, &N);
    let second = c.submit(s.bank(1), s.bank(2), &30, &U);

    c.deposit(s.bank(0), &30);

    assert_eq!(c.payment(&first).unwrap().status, Status::Settled);
    assert_eq!(c.payment(&second).unwrap().status, Status::Settled);
    assert_eq!(s.balances(), std::vec![0, 0, 30]);
    assert_eq!(c.queued_count(), 0);
    s.assert_conserved();
}

/// SC-A02-05. The cascade also runs from a submission: a payment that settles at once
/// covers the receiver's queued head, and both settle in the submitting call, the new
/// payment first.
#[test]
fn a_submission_that_settles_releases_the_receivers_queue() {
    let s = Setup::funded(&[30, 0, 0]);
    let c = s.client();
    let waiting = c.submit(s.bank(1), s.bank(2), &30, &N);

    let id = c.submit(s.bank(0), s.bank(1), &30, &N);

    assert_eq!(
        s.our_events(),
        std::vec![
            s.ev(Submitted {
                id,
                from: s.bank(0).clone(),
                to: s.bank(1).clone(),
                amount: 30,
                priority: N,
            }),
            s.ev(Settled {
                id,
                from: s.bank(0).clone(),
                to: s.bank(1).clone(),
                amount: 30,
            }),
            s.ev(Settled {
                id: waiting,
                from: s.bank(1).clone(),
                to: s.bank(2).clone(),
                amount: 30,
            }),
        ]
    );
    assert_eq!(s.balances(), std::vec![0, 0, 30]);
}

/// SC-A02-06. A withdrawal never settles anything (it only lowers a balance), and the
/// closure leaves the queue at rest (S9).
#[test]
fn a_withdrawal_settles_nothing() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    c.withdraw(s.bank(0), &10);
    assert_eq!(
        s.our_events(),
        std::vec![s.ev(Withdrawn {
            bank: s.bank(0).clone(),
            amount: 10,
        })]
    );
    assert_eq!(c.payment(&id).unwrap().status, Status::Queued);
}

/// S3, S5: once settled, a payment's record never changes, whatever happens later.
#[test]
fn a_settled_payment_never_changes() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    s.at(3);
    let id = c.submit(s.bank(0), s.bank(1), &40, &N);
    let before = c.payment(&id).unwrap();

    s.env.ledger().set_timestamp(10_000_000);
    c.submit(s.bank(1), s.bank(0), &40, &N);
    c.withdraw(s.bank(0), &100);

    assert_eq!(c.payment(&id).unwrap(), before);
}
