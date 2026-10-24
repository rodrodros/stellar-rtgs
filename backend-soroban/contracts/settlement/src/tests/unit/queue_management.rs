//! What can happen to a queued payment besides settling: A6 `Revoke` (ADR-0016), A8
//! `Reprioritise` (ADR-0009) and A5 `Reject`, here expiry (ADR-0015). Each can uncover
//! the payments behind it, so each ends with the eager closure (ADR-0010).
//!
//! Where the model differs: A6's cut-off τ_rc and A5's queue cut-off τ_qc belong to a
//! business day, which ADR-0013 removes. Revocation has no cut-off (ADR-0016), so
//! `irrev(o)` is "settled" and S20 holds trivially. Expiry, counted from submission,
//! replaces τ_qc (ADR-0015). v1 has no held or timed orders (A7, A9; ADR-0017).
use crate::tests::support::{default_config, Setup};
use crate::*;

const N: Priority = Priority::Normal;
const U: Priority = Priority::Urgent;

// ---------------------------------------------------------------------------------------
// A6 revoke

/// SC-A06-01. A6: the sender revokes a queued payment. It leaves its queue for good,
/// with status `Revoked` (S13; ADR-0016).
#[test]
fn a_queued_payment_can_be_revoked() {
    let s = Setup::funded(&[0, 0]);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);

    c.revoke(&id);

    assert_eq!(s.our_events(), std::vec![s.ev(Revoked { id })]);
    assert_eq!(c.payment(&id).unwrap().status, Status::Revoked);
    assert!(s.queue(0, N).is_empty());
    assert_eq!(c.queued_count(), 0);
    assert_eq!(s.balances(), std::vec![0, 0]);
}

/// SC-A06-02. ADR-0016: no cut-off. A payment queued long past its expiry time, but not
/// yet expired by anyone, can still be revoked.
#[test]
fn revocation_has_no_cut_off() {
    let s = Setup::new(2, 0);
    let c = s.client();
    s.at(1_000);
    let id = c.submit(s.bank(0), s.bank(1), &60, &U);
    s.at(1_000 + 10 * default_config().expiry_secs);

    c.revoke(&id);

    assert_eq!(c.payment(&id).unwrap().status, Status::Revoked);
}

/// SC-A06-03. S3, S5: a settled payment cannot be revoked (`NotQueued`), and nothing
/// changes. Settlement is the moment of irrevocability (M5, ADR-0005, ADR-0006).
#[test]
fn a_settled_payment_cannot_be_revoked() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &40, &N);
    let before = c.payment(&id).unwrap();

    assert_eq!(c.try_revoke(&id), Err(Ok(Error::NotQueued)));

    assert_eq!(c.payment(&id).unwrap(), before);
    assert_eq!(s.balances(), std::vec![60, 40]);
}

/// SC-A06-04. S3: a revoked payment cannot be revoked again.
#[test]
fn a_revoked_payment_cannot_be_revoked_again() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    c.revoke(&id);
    assert_eq!(c.try_revoke(&id), Err(Ok(Error::NotQueued)));
    assert_eq!(c.payment(&id).unwrap().status, Status::Revoked);
}

/// SC-A06-05. S3: an expired payment cannot be revoked.
#[test]
fn an_expired_payment_cannot_be_revoked() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    s.at(default_config().expiry_secs + 1);
    c.expire(&id);
    assert_eq!(c.try_revoke(&id), Err(Ok(Error::NotQueued)));
    assert_eq!(c.payment(&id).unwrap().status, Status::Expired);
}

/// SC-A06-06. An id that was never issued is `UnknownPayment`.
#[test]
fn revoking_an_unknown_payment_is_refused() {
    let s = Setup::new(1, 0);
    assert_eq!(s.client().try_revoke(&0), Err(Ok(Error::UnknownPayment)));
}

/// SC-A06-07. ADR-0016's consequence: revoking an uncovered head releases the covered
/// payment behind it in the same call (S9, L1).
#[test]
fn revoking_the_head_releases_the_payment_behind_it() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let head = c.submit(s.bank(0), s.bank(1), &60, &N);
    let behind = c.submit(s.bank(0), s.bank(1), &10, &N);

    c.revoke(&head);

    assert_eq!(
        s.our_events(),
        std::vec![
            s.ev(Revoked { id: head }),
            s.ev(Settled {
                id: behind,
                from: s.bank(0).clone(),
                to: s.bank(1).clone(),
                amount: 10,
            }),
        ]
    );
    assert_eq!(s.balances(), std::vec![40, 10]);
    assert_eq!(c.queued_count(), 0);
}

/// SC-A06-08. Revoking a queued urgent payment unblocks the bank's normal queue
/// (ADR-0009).
#[test]
fn revoking_the_urgent_head_releases_normal_payments() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let urgent = c.submit(s.bank(0), s.bank(1), &60, &U);
    let normal = c.submit(s.bank(0), s.bank(1), &10, &N);
    c.revoke(&urgent);
    assert_eq!(c.payment(&normal).unwrap().status, Status::Settled);
}

/// SC-A06-09. Revoking a payment that is not at the head keeps the others in order.
#[test]
fn revoking_from_the_middle_keeps_the_queue_order() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let ids: std::vec::Vec<u64> = (0..3)
        .map(|_| c.submit(s.bank(0), s.bank(1), &10, &N))
        .collect();
    c.revoke(&ids[1]);
    assert_eq!(s.queue(0, N), std::vec![ids[0], ids[2]]);
    assert_eq!(c.queued_count(), 2);
}

// ---------------------------------------------------------------------------------------
// A8 reprioritise, keeping the payment's place (toEnd = false)

/// SC-A08-01. A8: a normal payment moved to urgent keeps its sequence number, so it goes
/// into the urgent queue at its place by age, not at the end (ADR-0009; decision on A8).
#[test]
fn a_promoted_payment_keeps_its_place_by_age() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let u0 = c.submit(s.bank(0), s.bank(1), &10, &U);
    let n1 = c.submit(s.bank(0), s.bank(1), &10, &N);
    let u2 = c.submit(s.bank(0), s.bank(1), &10, &U);

    c.reprioritise(&n1, &U);

    assert_eq!(
        s.our_events(),
        std::vec![s.ev(Reprioritised {
            id: n1,
            priority: U,
        })]
    );
    assert_eq!(s.queue(0, U), std::vec![u0, n1, u2]);
    assert!(s.queue(0, N).is_empty());
    let p = c.payment(&n1).unwrap();
    assert_eq!((p.id, p.priority, p.status), (n1, U, Status::Queued));
    assert_eq!(c.queued_count(), 3);
}

/// SC-A08-02. A8 the other way: a demoted urgent payment slots into the normal queue by
/// age.
#[test]
fn a_demoted_payment_keeps_its_place_by_age() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let n0 = c.submit(s.bank(0), s.bank(1), &10, &N);
    let u1 = c.submit(s.bank(0), s.bank(1), &10, &U);
    let n2 = c.submit(s.bank(0), s.bank(1), &10, &N);

    c.reprioritise(&u1, &N);

    assert_eq!(s.queue(0, N), std::vec![n0, u1, n2]);
    assert!(s.queue(0, U).is_empty());
}

/// SC-A08-03. Promoting a covered payment stuck behind an uncovered head of its old
/// queue makes it the urgent head, and it settles in the same call (ADR-0009, S9).
#[test]
fn promoting_a_blocked_covered_payment_settles_it() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let head = c.submit(s.bank(0), s.bank(1), &60, &N);
    let small = c.submit(s.bank(0), s.bank(1), &10, &N);

    c.reprioritise(&small, &U);

    assert_eq!(
        s.our_events(),
        std::vec![
            s.ev(Reprioritised {
                id: small,
                priority: U,
            }),
            s.ev(Settled {
                id: small,
                from: s.bank(0).clone(),
                to: s.bank(1).clone(),
                amount: 10,
            }),
        ]
    );
    assert_eq!(s.queue(0, N), std::vec![head]);
    assert_eq!(s.balances(), std::vec![40, 10]);
}

/// SC-A08-04. Demoting an uncovered urgent payment unblocks the bank's older, covered
/// normal payment, which settles in the same call (ADR-0009, S7(a), S9).
#[test]
fn demoting_an_uncovered_urgent_payment_releases_older_normal_ones() {
    let s = Setup::new(2, 10);
    let c = s.client();
    let normal = c.submit(s.bank(0), s.bank(1), &10, &N);
    let urgent = c.submit(s.bank(0), s.bank(1), &60, &U);
    c.deposit(s.bank(0), &10);
    assert_eq!(c.payment(&normal).unwrap().status, Status::Queued);

    c.reprioritise(&urgent, &N);

    assert_eq!(c.payment(&normal).unwrap().status, Status::Settled);
    assert_eq!(s.queue(0, N), std::vec![urgent]);
    assert_eq!(s.balances(), std::vec![0, 10]);
}

/// SC-A08-05. Moving a payment to the priority it already has is refused with
/// `SamePriority`, and nothing changes.
#[test]
fn reprioritising_to_the_same_priority_is_refused() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &10, &N);
    assert_eq!(c.try_reprioritise(&id, &N), Err(Ok(Error::SamePriority)));
    assert_eq!(s.queue(0, N), std::vec![id]);
}

/// SC-A08-06. S3, S5: only a queued payment can be reprioritised; a settled one gives
/// `NotQueued` and keeps its priority.
#[test]
fn a_settled_payment_cannot_be_reprioritised() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &10, &N);
    assert_eq!(c.try_reprioritise(&id, &U), Err(Ok(Error::NotQueued)));
    assert_eq!(c.payment(&id).unwrap().priority, N);
}

/// SC-A08-07. An id that was never issued is `UnknownPayment`.
#[test]
fn reprioritising_an_unknown_payment_is_refused() {
    let s = Setup::new(1, 0);
    assert_eq!(
        s.client().try_reprioritise(&7, &U),
        Err(Ok(Error::UnknownPayment))
    );
}

// ---------------------------------------------------------------------------------------
// A5 expire (ADR-0015, replacing τ_qc)

/// SC-A05-01. A5 after ADR-0015: once more than `expiry_secs` have passed since
/// submission, anyone may reject the payment. Its status becomes `Expired` (the model's
/// `rejected`) and it leaves its queue.
#[test]
fn a_payment_past_its_expiry_can_be_expired() {
    let s = Setup::new(2, 0);
    let c = s.client();
    s.at(1_000);
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    s.at(1_000 + default_config().expiry_secs + 1);

    c.expire(&id);

    assert_eq!(s.our_events(), std::vec![s.ev(Expired { id })]);
    assert_eq!(c.payment(&id).unwrap().status, Status::Expired);
    assert!(s.queue(0, N).is_empty());
    assert_eq!(c.queued_count(), 0);
}

/// SC-A05-02. The boundary: exactly at `submitted_at + expiry_secs` the payment has not
/// expired (A5's guard is `t > τ`), so `NotExpired`. With CAP-88 two ledgers may share a
/// timestamp, and a strict comparison stays correct (handbook 09 §3).
#[test]
fn a_payment_exactly_at_its_expiry_has_not_expired() {
    let s = Setup::new(2, 0);
    let c = s.client();
    s.at(1_000);
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);

    for t in [1_000, 1_000 + default_config().expiry_secs] {
        s.at(t);
        assert_eq!(c.try_expire(&id), Err(Ok(Error::NotExpired)));
    }
    assert_eq!(c.payment(&id).unwrap().status, Status::Queued);
}

/// SC-A05-03. The expiry is a configuration value (ADR-0015): with a 10-second expiry, a
/// payment expires at its 11th second.
#[test]
fn the_expiry_is_configurable() {
    let s = Setup::with_config(
        2,
        0,
        Config {
            expiry_secs: 10,
            ..default_config()
        },
    );
    let c = s.client();
    s.at(50);
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    s.at(60);
    assert_eq!(c.try_expire(&id), Err(Ok(Error::NotExpired)));
    s.at(61);
    c.expire(&id);
    assert_eq!(c.payment(&id).unwrap().status, Status::Expired);
}

/// SC-A05-04. ADR-0015's consequence: expiring an uncovered head releases the payment
/// behind it, in the same call (S9).
#[test]
fn expiring_the_head_releases_the_payment_behind_it() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let head = c.submit(s.bank(0), s.bank(1), &60, &N);
    let behind = c.submit(s.bank(0), s.bank(1), &10, &N);
    s.at(default_config().expiry_secs + 1);

    c.expire(&head);

    assert_eq!(
        s.our_events(),
        std::vec![
            s.ev(Expired { id: head }),
            s.ev(Settled {
                id: behind,
                from: s.bank(0).clone(),
                to: s.bank(1).clone(),
                amount: 10,
            }),
        ]
    );
    assert_eq!(s.balances(), std::vec![40, 10]);
}

/// SC-A05-05. Each payment's expiry runs from its own submission: a later payment has
/// not expired when an earlier one has.
#[test]
fn each_payment_expires_from_its_own_submission() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let expiry = default_config().expiry_secs;
    s.at(0);
    let early = c.submit(s.bank(0), s.bank(1), &60, &N);
    s.at(100);
    let late = c.submit(s.bank(0), s.bank(1), &60, &N);
    s.at(expiry + 1);
    c.expire(&early);
    assert_eq!(c.try_expire(&late), Err(Ok(Error::NotExpired)));
}

/// SC-A05-06. S3, S5: a settled payment never expires; `NotQueued`.
#[test]
fn a_settled_payment_cannot_be_expired() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &10, &N);
    s.at(default_config().expiry_secs + 1);
    assert_eq!(c.try_expire(&id), Err(Ok(Error::NotQueued)));
    assert_eq!(c.payment(&id).unwrap().status, Status::Settled);
}

/// SC-A05-07. S3: a revoked payment cannot be expired.
#[test]
fn a_revoked_payment_cannot_be_expired() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &10, &N);
    c.revoke(&id);
    s.at(default_config().expiry_secs + 1);
    assert_eq!(c.try_expire(&id), Err(Ok(Error::NotQueued)));
}

/// SC-A05-08. An id that was never issued is `UnknownPayment`.
#[test]
fn expiring_an_unknown_payment_is_refused() {
    let s = Setup::new(1, 0);
    assert_eq!(s.client().try_expire(&3), Err(Ok(Error::UnknownPayment)));
}
