//! A3 `Offset` under Spec O with F2, one phase and `eagerLSM` (ADR-0010): once no head
//! is covered, the contract settles the greatest feasible prefix of every bank's queue in
//! the same transaction. The prefix rule itself is unit-tested in `rtgs-core`; these
//! tests check that the contract applies it.
//!
//! A bank's candidates are its queued payments in `≺` order: urgent before normal, then
//! by id (§4.5). v1 has no linked groups, so F5 and S16 do not arise.
use soroban_sdk::vec;

use crate::tests::support::Setup;
use crate::*;

const N: Priority = Priority::Normal;
const U: Priority = Priority::Urgent;

/// SC-A03-01. R7's gridlock (§4.10, §4.11): A→B 15, B→C 20, C→A 25 with every balance
/// 10. Gross processing settles nothing (`k_seq` = 0), and the third submission applies
/// k* = (1, 1, 1) as one offset in the same transaction (A3, S10, S23, L2 with bound 0;
/// ADR-0010).
#[test]
fn r7_gridlock_is_resolved_in_the_submission_that_makes_it_feasible() {
    let s = Setup::funded(&[10, 10, 10]);
    let c = s.client();
    let ab = c.submit(s.bank(0), s.bank(1), &15, &N);
    let bc = c.submit(s.bank(1), s.bank(2), &20, &N);
    assert_eq!(c.queued_count(), 2);

    let ca = c.submit(s.bank(2), s.bank(0), &25, &N);

    let settled = |id: u64, from: usize, to: usize, amount: i128| {
        s.ev(Settled {
            id,
            from: s.bank(from).clone(),
            to: s.bank(to).clone(),
            amount,
        })
    };
    assert_eq!(
        s.our_events(),
        std::vec![
            s.ev(Submitted {
                id: ca,
                from: s.bank(2).clone(),
                to: s.bank(0).clone(),
                amount: 25,
                priority: N,
            }),
            s.ev(Offset {
                ids: vec![&s.env, ab, bc, ca],
            }),
            settled(ab, 0, 1, 15),
            settled(bc, 1, 2, 20),
            settled(ca, 2, 0, 25),
        ]
    );
    // F1 with `lim` = 0: every post-offset balance is non-negative.
    assert_eq!(s.balances(), std::vec![20, 5, 5]);
    assert_eq!(c.queued_count(), 0);
    s.assert_conserved();
}

/// SC-A03-02. A bilateral offset: two banks with nothing each owe each other 50. Neither
/// payment is covered alone, both settle together (A3, F1).
#[test]
fn two_opposite_payments_offset_with_no_liquidity() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let ab = c.submit(s.bank(0), s.bank(1), &50, &N);
    let ba = c.submit(s.bank(1), s.bank(0), &50, &U);
    assert_eq!(c.payment(&ab).unwrap().status, Status::Settled);
    assert_eq!(c.payment(&ba).unwrap().status, Status::Settled);
    assert_eq!(s.balances(), std::vec![0, 0]);
    s.assert_conserved();
}

/// SC-A03-03. The prefix is the greatest feasible one, not all or nothing: A's second
/// payment does not fit, so k* = (1, 1) and it stays queued (R4, Spec O).
#[test]
fn the_offset_settles_the_greatest_feasible_prefix_and_leaves_the_rest() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let a1 = c.submit(s.bank(0), s.bank(1), &50, &N);
    let a2 = c.submit(s.bank(0), s.bank(1), &30, &N);
    let b1 = c.submit(s.bank(1), s.bank(0), &50, &N);

    assert_eq!(
        s.our_events()[1],
        s.ev(Offset {
            ids: vec![&s.env, a1, b1],
        })
    );
    assert_eq!(c.payment(&a2).unwrap().status, Status::Queued);
    assert_eq!(s.queue(0, N), std::vec![a2]);
    assert_eq!(s.balances(), std::vec![0, 0]);
    s.assert_conserved();
}

/// SC-A03-04. F2 and F6, S7 for A3 (ADR-0008): the offset never takes a payment ahead of
/// an older one of the same bank. B→A 50 could offset A's second payment, but A's first,
/// 100, does not fit, so nothing settles.
#[test]
fn the_offset_never_overtakes_an_older_payment() {
    let s = Setup::new(2, 0);
    let c = s.client();
    c.submit(s.bank(0), s.bank(1), &100, &N);
    let a2 = c.submit(s.bank(0), s.bank(1), &50, &N);
    let b1 = c.submit(s.bank(1), s.bank(0), &50, &N);
    assert_eq!(c.payment(&a2).unwrap().status, Status::Queued);
    assert_eq!(c.payment(&b1).unwrap().status, Status::Queued);
    assert_eq!(c.queued_count(), 3);
    assert_eq!(s.balances(), std::vec![0, 0]);
}

/// SC-A03-05. The candidate order is `≺`, urgent first (§4.5, ADR-0009): A's urgent 100,
/// though younger, comes before its normal 50, so the prefix cannot take the 50 alone.
#[test]
fn the_offset_takes_a_banks_urgent_payments_before_its_normal_ones() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let normal = c.submit(s.bank(0), s.bank(1), &50, &N);
    let urgent = c.submit(s.bank(0), s.bank(1), &100, &U);
    let b1 = c.submit(s.bank(1), s.bank(0), &50, &N);
    for id in [normal, urgent, b1] {
        assert_eq!(c.payment(&id).unwrap().status, Status::Queued);
    }
}

/// SC-A03-06. The offset also runs after a deposit (ADR-0010: "the transaction that makes
/// it feasible"), and after gross settlement has come to rest.
#[test]
fn a_deposit_can_make_an_offset_feasible() {
    let s = Setup::new(3, 10);
    let c = s.client();
    let ab = c.submit(s.bank(0), s.bank(1), &60, &N);
    let ba = c.submit(s.bank(1), s.bank(0), &50, &N);
    assert_eq!(c.queued_count(), 2);

    c.deposit(s.bank(0), &10);

    assert_eq!(c.payment(&ab).unwrap().status, Status::Settled);
    assert_eq!(c.payment(&ba).unwrap().status, Status::Settled);
    assert_eq!(s.balances(), std::vec![0, 10, 0]);
    s.assert_conserved();
}

/// SC-A03-07. Sums at the `i128` limit: B's two queued payments of `i128::MAX` add up to
/// more than `i128` holds. The contract treats that prefix as infeasible rather than
/// panicking, and settles the feasible one (R4, F1).
#[test]
fn an_outflow_that_overflows_i128_is_infeasible_not_a_panic() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let b1 = c.submit(s.bank(1), s.bank(0), &i128::MAX, &N);
    let b2 = c.submit(s.bank(1), s.bank(0), &i128::MAX, &N);

    let a1 = c.submit(s.bank(0), s.bank(1), &i128::MAX, &N);

    assert_eq!(c.payment(&a1).unwrap().status, Status::Settled);
    assert_eq!(c.payment(&b1).unwrap().status, Status::Settled);
    assert_eq!(c.payment(&b2).unwrap().status, Status::Queued);
    assert_eq!(s.balances(), std::vec![0, 0]);
}

/// SC-A03-08. S23 after the offset (R5, strict FIFO): no head left is covered and no
/// further prefix is feasible, so a later submission that adds nothing feasible settles
/// nothing.
#[test]
fn after_an_offset_the_queues_are_at_rest() {
    let s = Setup::new(3, 0);
    let c = s.client();
    c.submit(s.bank(0), s.bank(1), &50, &N);
    c.submit(s.bank(0), s.bank(2), &70, &N);
    c.submit(s.bank(1), s.bank(0), &50, &N);
    assert_eq!(s.queue(0, N), std::vec![1]);

    c.submit(s.bank(2), s.bank(1), &5, &N);

    assert_eq!(s.queue(0, N), std::vec![1]);
    assert_eq!(s.queue(2, N), std::vec![3]);
    s.assert_conserved();
}
