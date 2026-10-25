//! A3 `Offset` under Spec O with F2, one phase and `eagerLSM` (ADR-0010): once no head
//! is covered, the contract settles the greatest feasible prefix of every bank's queue in
//! the same transaction. The prefix rule itself is unit-tested in `rtgs-core`; these
//! tests check that the contract applies it.
//!
//! A bank's candidates are its queued payments in `≺` order: urgent before normal, then
//! by id (§4.5). v1 has no linked groups, so F5 and S16 do not arise.
//!
//! Where the model differs: A3's guard `phase = Open`, and its eligibility condition
//! `v(o) = day`, do not apply, since there is no business day (ADR-0013).
use soroban_sdk::vec;

use crate::tests::support::Setup;
use crate::*;

const NORMAL: Priority = Priority::Normal;
const URGENT: Priority = Priority::Urgent;

/// SC-A03-01. R7's gridlock (§4.10, §4.11): A→B 15, B→C 20, C→A 25 with every balance
/// 10. Gross processing settles nothing (`k_seq` = 0), and the third submission applies
/// k* = (1, 1, 1) as one offset in the same transaction (A3, S10, S23, L2 with bound 0;
/// ADR-0010).
#[test]
fn r7_gridlock_is_resolved_in_the_submission_that_makes_it_feasible() {
    let setup = Setup::funded(&[10, 10, 10]);
    let client = setup.client();
    let ab = client.submit(setup.bank(0), setup.bank(1), &15, &NORMAL);
    let bc = client.submit(setup.bank(1), setup.bank(2), &20, &NORMAL);
    assert_eq!(client.queued_count(), 2);

    let ca = client.submit(setup.bank(2), setup.bank(0), &25, &NORMAL);

    let settled = |id: u64, from: usize, to: usize, amount: i128| {
        setup.ev(Settled {
            id,
            from: setup.bank(from).clone(),
            to: setup.bank(to).clone(),
            amount,
        })
    };
    assert_eq!(
        setup.our_events(),
        std::vec![
            setup.ev(Submitted {
                id: ca,
                from: setup.bank(2).clone(),
                to: setup.bank(0).clone(),
                amount: 25,
                priority: NORMAL,
            }),
            setup.ev(Offset {
                ids: vec![&setup.env, ab, bc, ca],
            }),
            settled(ab, 0, 1, 15),
            settled(bc, 1, 2, 20),
            settled(ca, 2, 0, 25),
        ]
    );
    // F1 with `lim` = 0: every post-offset balance is non-negative.
    assert_eq!(setup.balances(), std::vec![20, 5, 5]);
    assert_eq!(client.queued_count(), 0);
    setup.assert_conserved();
}

/// SC-A03-02. A bilateral offset: two banks with nothing each owe each other 50. Neither
/// payment is covered alone, both settle together (A3, F1).
#[test]
fn two_opposite_payments_offset_with_no_liquidity() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let ab = client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);
    let ba = client.submit(setup.bank(1), setup.bank(0), &50, &URGENT);
    assert_eq!(client.payment(&ab).unwrap().status, Status::Settled);
    assert_eq!(client.payment(&ba).unwrap().status, Status::Settled);
    assert_eq!(setup.balances(), std::vec![0, 0]);
    setup.assert_conserved();
}

/// SC-A03-03. The prefix is the greatest feasible one, not all or nothing: A's second
/// payment does not fit, so k* = (1, 1) and it stays queued (R4, Spec O).
#[test]
fn the_offset_settles_the_greatest_feasible_prefix_and_leaves_the_rest() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let a1 = client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);
    let a2 = client.submit(setup.bank(0), setup.bank(1), &30, &NORMAL);
    let b1 = client.submit(setup.bank(1), setup.bank(0), &50, &NORMAL);

    assert_eq!(
        setup.our_events()[1],
        setup.ev(Offset {
            ids: vec![&setup.env, a1, b1],
        })
    );
    assert_eq!(client.payment(&a2).unwrap().status, Status::Queued);
    assert_eq!(setup.queue(0, NORMAL), std::vec![a2]);
    assert_eq!(setup.balances(), std::vec![0, 0]);
    setup.assert_conserved();
}

/// SC-A03-04. F2 and F6, S7 for A3 (ADR-0008): the offset never takes a payment ahead of
/// an older one of the same bank. B→A 50 could offset A's second payment, but A's first,
/// 100, does not fit, so nothing settles.
#[test]
fn the_offset_never_overtakes_an_older_payment() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    client.submit(setup.bank(0), setup.bank(1), &100, &NORMAL);
    let a2 = client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);
    let b1 = client.submit(setup.bank(1), setup.bank(0), &50, &NORMAL);
    assert_eq!(client.payment(&a2).unwrap().status, Status::Queued);
    assert_eq!(client.payment(&b1).unwrap().status, Status::Queued);
    assert_eq!(client.queued_count(), 3);
    assert_eq!(setup.balances(), std::vec![0, 0]);
}

/// SC-A03-05. The candidate order is `≺`, urgent first (§4.5, ADR-0009): A's urgent 100,
/// though younger, comes before its normal 50, so the prefix cannot take the 50 alone.
#[test]
fn the_offset_takes_a_banks_urgent_payments_before_its_normal_ones() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let normal = client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);
    let urgent = client.submit(setup.bank(0), setup.bank(1), &100, &URGENT);
    let b1 = client.submit(setup.bank(1), setup.bank(0), &50, &NORMAL);
    for id in [normal, urgent, b1] {
        assert_eq!(client.payment(&id).unwrap().status, Status::Queued);
    }
}

/// SC-A03-06. The offset also runs after a deposit (ADR-0010: "the transaction that makes
/// it feasible"), and after gross settlement has come to rest.
#[test]
fn a_deposit_can_make_an_offset_feasible() {
    let setup = Setup::new(3, 10);
    let client = setup.client();
    let ab = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    let ba = client.submit(setup.bank(1), setup.bank(0), &50, &NORMAL);
    assert_eq!(client.queued_count(), 2);

    client.deposit(setup.bank(0), &10);

    assert_eq!(client.payment(&ab).unwrap().status, Status::Settled);
    assert_eq!(client.payment(&ba).unwrap().status, Status::Settled);
    assert_eq!(setup.balances(), std::vec![0, 10, 0]);
    setup.assert_conserved();
}

/// SC-A03-07. Sums at the `i128` limit: B's two `i128::MAX` sum past `i128` without a
/// panic. With both, B would end at −`i128::MAX`, so its prefix is cut back to one, and
/// the feasible offset settles (R4, F1).
#[test]
fn at_the_i128_limit_the_offset_cuts_back_the_prefix_that_would_leave_a_bank_negative() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let b1 = client.submit(setup.bank(1), setup.bank(0), &i128::MAX, &NORMAL);
    let b2 = client.submit(setup.bank(1), setup.bank(0), &i128::MAX, &NORMAL);

    let a1 = client.submit(setup.bank(0), setup.bank(1), &i128::MAX, &NORMAL);

    assert_eq!(client.payment(&a1).unwrap().status, Status::Settled);
    assert_eq!(client.payment(&b1).unwrap().status, Status::Settled);
    assert_eq!(client.payment(&b2).unwrap().status, Status::Queued);
    assert_eq!(setup.balances(), std::vec![0, 0]);
}

/// SC-A03-08. S23 after the offset (R5, strict FIFO): no head left is covered and no
/// further prefix is feasible, so a later submission that adds nothing feasible settles
/// nothing.
#[test]
fn after_an_offset_the_queues_are_at_rest() {
    let setup = Setup::new(3, 0);
    let client = setup.client();
    client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);
    client.submit(setup.bank(0), setup.bank(2), &70, &NORMAL);
    client.submit(setup.bank(1), setup.bank(0), &50, &NORMAL);
    assert_eq!(setup.queue(0, NORMAL), std::vec![1]);

    client.submit(setup.bank(2), setup.bank(1), &5, &NORMAL);

    assert_eq!(setup.queue(0, NORMAL), std::vec![1]);
    assert_eq!(setup.queue(2, NORMAL), std::vec![3]);
    setup.assert_conserved();
}

/// SC-A03-11. F1 is decided exactly, even where the sums exceed `i128` (ADR-0010). A
/// has 1 and B nothing. A queues A→B twice `i128::MAX / 2 + 1`, whose sum is one more than
/// `i128::MAX`, and B then submits B→A `i128::MAX`. A ends at 0 and B at 1, so k* = (2, 1)
/// and all three settle in that submission. A rule that treats A's overflowing outflow as
/// infeasible would find no feasible prefix and leave them gridlocked (S23).
#[test]
fn an_offset_whose_sums_exceed_i128_still_settles() {
    let setup = Setup::funded(&[1, 0]);
    let client = setup.client();
    let over_half = i128::MAX / 2 + 1;
    let a1 = client.submit(setup.bank(0), setup.bank(1), &over_half, &NORMAL);
    let a2 = client.submit(setup.bank(0), setup.bank(1), &over_half, &NORMAL);
    assert_eq!(client.queued_count(), 2);

    let b1 = client.submit(setup.bank(1), setup.bank(0), &i128::MAX, &NORMAL);

    for id in [a1, a2, b1] {
        assert_eq!(client.payment(&id).unwrap().status, Status::Settled);
    }
    assert_eq!(client.queued_count(), 0);
    assert_eq!(setup.balances(), std::vec![0, 1]);
    setup.assert_conserved();
}

/// SC-A03-12. The offset books each bank's net change exactly (A3, S1, S2; ADR-0010).
/// With every balance 0, A→B, A→C and C→A queue, all `i128::MAX`, and B→A `i128::MAX`
/// then makes k* = (2, 1, 1). A's outflow and inflow are each 2 · `i128::MAX`: debiting
/// first, or payment by payment in id order, takes A to −2 · `i128::MAX`. All four settle
/// and every balance ends at 0.
#[test]
fn an_offset_books_each_banks_net_change_exactly() {
    let setup = Setup::new(3, 0);
    let client = setup.client();
    let max = i128::MAX;
    let ab = client.submit(setup.bank(0), setup.bank(1), &max, &NORMAL);
    let ac = client.submit(setup.bank(0), setup.bank(2), &max, &NORMAL);
    let ca = client.submit(setup.bank(2), setup.bank(0), &max, &NORMAL);
    assert_eq!(client.queued_count(), 3);

    let ba = client.submit(setup.bank(1), setup.bank(0), &max, &NORMAL);

    for id in [ca, ab, ac, ba] {
        assert_eq!(client.payment(&id).unwrap().status, Status::Settled);
    }
    assert_eq!(client.queued_count(), 0);
    assert_eq!(setup.balances(), std::vec![0, 0, 0]);
    setup.assert_conserved();
}
