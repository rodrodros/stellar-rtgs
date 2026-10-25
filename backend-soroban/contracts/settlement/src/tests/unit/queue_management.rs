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

const NORMAL: Priority = Priority::Normal;
const URGENT: Priority = Priority::Urgent;

// ---------------------------------------------------------------------------------------
// A6 revoke

/// SC-A06-01. A6: the sender revokes a queued payment. It leaves its queue for good,
/// with status `Revoked` (S13; ADR-0016).
#[test]
fn a_queued_payment_can_be_revoked() {
    let setup = Setup::funded(&[0, 0]);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);

    client.revoke(&id);

    assert_eq!(setup.our_events(), std::vec![setup.ev(Revoked { id })]);
    assert_eq!(client.payment(&id).unwrap().status, Status::Revoked);
    assert!(setup.queue(0, NORMAL).is_empty());
    assert_eq!(client.queued_count(), 0);
    assert_eq!(setup.balances(), std::vec![0, 0]);
}

/// SC-A06-02. ADR-0016: no cut-off. A payment queued long past its expiry time, but not
/// yet expired by anyone, can still be revoked.
#[test]
fn revocation_has_no_cut_off() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    setup.at(1_000);
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &URGENT);
    setup.at(1_000 + 10 * default_config().expiry_secs);

    client.revoke(&id);

    assert_eq!(client.payment(&id).unwrap().status, Status::Revoked);
}

/// SC-A06-03. S3, S5: a settled payment cannot be revoked (`NotQueued`), and nothing
/// changes. Settlement is the moment of irrevocability (M5, ADR-0005, ADR-0006).
#[test]
fn a_settled_payment_cannot_be_revoked() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &40, &NORMAL);
    let before = client.payment(&id).unwrap();

    assert_eq!(client.try_revoke(&id), Err(Ok(Error::NotQueued)));

    assert_eq!(client.payment(&id).unwrap(), before);
    assert_eq!(setup.balances(), std::vec![60, 40]);
}

/// SC-A06-04. S3: a revoked payment cannot be revoked again.
#[test]
fn a_revoked_payment_cannot_be_revoked_again() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    client.revoke(&id);
    assert_eq!(client.try_revoke(&id), Err(Ok(Error::NotQueued)));
    assert_eq!(client.payment(&id).unwrap().status, Status::Revoked);
}

/// SC-A06-05. S3: an expired payment cannot be revoked.
#[test]
fn an_expired_payment_cannot_be_revoked() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    setup.at(default_config().expiry_secs + 1);
    client.expire(&id);
    assert_eq!(client.try_revoke(&id), Err(Ok(Error::NotQueued)));
    assert_eq!(client.payment(&id).unwrap().status, Status::Expired);
}

/// SC-A06-06. An id that was never issued is `UnknownPayment`.
#[test]
fn revoking_an_unknown_payment_is_refused() {
    let setup = Setup::new(1, 0);
    assert_eq!(
        setup.client().try_revoke(&0),
        Err(Ok(Error::UnknownPayment))
    );
}

/// SC-A06-07. ADR-0016's consequence: revoking an uncovered head releases the covered
/// payment behind it in the same call (S9, L1).
#[test]
fn revoking_the_head_releases_the_payment_behind_it() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let head = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    let behind = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);

    client.revoke(&head);

    assert_eq!(
        setup.our_events(),
        std::vec![
            setup.ev(Revoked { id: head }),
            setup.ev(Settled {
                id: behind,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 10,
            }),
        ]
    );
    assert_eq!(setup.balances(), std::vec![40, 10]);
    assert_eq!(client.queued_count(), 0);
}

/// SC-A06-08. Revoking a queued urgent payment unblocks the bank's normal queue
/// (ADR-0009).
#[test]
fn revoking_the_urgent_head_releases_normal_payments() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let urgent = client.submit(setup.bank(0), setup.bank(1), &60, &URGENT);
    let normal = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    client.revoke(&urgent);
    assert_eq!(client.payment(&normal).unwrap().status, Status::Settled);
}

/// SC-A06-09. Revoking a payment that is not at the head keeps the others in order.
#[test]
fn revoking_from_the_middle_keeps_the_queue_order() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let ids: std::vec::Vec<u64> = (0..3)
        .map(|_| client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL))
        .collect();
    client.revoke(&ids[1]);
    assert_eq!(setup.queue(0, NORMAL), std::vec![ids[0], ids[2]]);
    assert_eq!(client.queued_count(), 2);
}

// ---------------------------------------------------------------------------------------
// A8 reprioritise, keeping the payment's place (toEnd = false)

/// SC-A08-01. A8: a normal payment moved to urgent keeps its sequence number, so it goes
/// into the urgent queue at its place by age, not at the end (ADR-0009; decision on A8).
#[test]
fn a_promoted_payment_keeps_its_place_by_age() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let u0 = client.submit(setup.bank(0), setup.bank(1), &10, &URGENT);
    let n1 = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    let u2 = client.submit(setup.bank(0), setup.bank(1), &10, &URGENT);

    client.reprioritise(&n1, &URGENT);

    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(Reprioritised {
            id: n1,
            priority: URGENT,
        })]
    );
    assert_eq!(setup.queue(0, URGENT), std::vec![u0, n1, u2]);
    assert!(setup.queue(0, NORMAL).is_empty());
    let payment = client.payment(&n1).unwrap();
    assert_eq!(
        (payment.id, payment.priority, payment.status),
        (n1, URGENT, Status::Queued)
    );
    assert_eq!(client.queued_count(), 3);
}

/// SC-A08-02. A8 the other way: a demoted urgent payment slots into the normal queue by
/// age.
#[test]
fn a_demoted_payment_keeps_its_place_by_age() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let n0 = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    let u1 = client.submit(setup.bank(0), setup.bank(1), &10, &URGENT);
    let n2 = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);

    client.reprioritise(&u1, &NORMAL);

    assert_eq!(setup.queue(0, NORMAL), std::vec![n0, u1, n2]);
    assert!(setup.queue(0, URGENT).is_empty());
}

/// SC-A08-03. Promoting a covered payment stuck behind an uncovered head of its old
/// queue makes it the urgent head, and it settles in the same call (ADR-0009, S9).
#[test]
fn promoting_a_blocked_covered_payment_settles_it() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let head = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    let small = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);

    client.reprioritise(&small, &URGENT);

    assert_eq!(
        setup.our_events(),
        std::vec![
            setup.ev(Reprioritised {
                id: small,
                priority: URGENT,
            }),
            setup.ev(Settled {
                id: small,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 10,
            }),
        ]
    );
    assert_eq!(setup.queue(0, NORMAL), std::vec![head]);
    assert_eq!(client.queued_count(), 1);
    assert_eq!(setup.balances(), std::vec![40, 10]);
}

/// SC-A08-04. Demoting an uncovered urgent payment unblocks the bank's older, covered
/// normal payment, which settles in the same call (ADR-0009, S7(a), S9).
#[test]
fn demoting_an_uncovered_urgent_payment_releases_older_normal_ones() {
    let setup = Setup::new(2, 10);
    let client = setup.client();
    let normal = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    let urgent = client.submit(setup.bank(0), setup.bank(1), &60, &URGENT);
    client.deposit(setup.bank(0), &10);
    assert_eq!(client.payment(&normal).unwrap().status, Status::Queued);

    client.reprioritise(&urgent, &NORMAL);

    assert_eq!(client.payment(&normal).unwrap().status, Status::Settled);
    assert_eq!(setup.queue(0, NORMAL), std::vec![urgent]);
    assert_eq!(client.queued_count(), 1);
    assert_eq!(setup.balances(), std::vec![0, 10]);
}

/// SC-A08-05. Moving a payment to the priority it already has is refused with
/// `SamePriority`, and nothing changes. This refines A8, whose guard allows π' = π as a
/// no-op; the Quint spec refuses it too.
#[test]
fn reprioritising_to_the_same_priority_is_refused() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    assert_eq!(
        client.try_reprioritise(&id, &NORMAL),
        Err(Ok(Error::SamePriority))
    );
    assert_eq!(setup.queue(0, NORMAL), std::vec![id]);
}

/// SC-A08-06. S3, S5: only a queued payment can be reprioritised; a settled one gives
/// `NotQueued` and keeps its priority.
#[test]
fn a_settled_payment_cannot_be_reprioritised() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    assert_eq!(
        client.try_reprioritise(&id, &URGENT),
        Err(Ok(Error::NotQueued))
    );
    assert_eq!(client.payment(&id).unwrap().priority, NORMAL);
}

/// SC-A08-07. An id that was never issued is `UnknownPayment`.
#[test]
fn reprioritising_an_unknown_payment_is_refused() {
    let setup = Setup::new(1, 0);
    assert_eq!(
        setup.client().try_reprioritise(&7, &URGENT),
        Err(Ok(Error::UnknownPayment))
    );
}

/// SC-A08-09. S3, S5: a revoked payment gives `NotQueued` too, whichever priority it is
/// moved to, keeps its priority and stays out of every queue. Added in Flow 10, since
/// SC-A08-06's payment is settled; it fails if the guard refuses only a settled payment
/// and lets a revoked one back into a queue, or if `SamePriority` is checked before
/// `NotQueued`, against the Quint spec's order.
#[test]
fn a_revoked_payment_cannot_be_reprioritised() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    client.revoke(&id);

    assert_eq!(
        client.try_reprioritise(&id, &URGENT),
        Err(Ok(Error::NotQueued))
    );
    assert_eq!(
        client.try_reprioritise(&id, &NORMAL),
        Err(Ok(Error::NotQueued))
    );

    let payment = client.payment(&id).unwrap();
    assert_eq!(
        (payment.priority, payment.status),
        (NORMAL, Status::Revoked)
    );
    assert!(setup.queue(0, URGENT).is_empty());
    assert!(setup.queue(0, NORMAL).is_empty());
    assert_eq!(client.queued_count(), 0);
}

/// SC-A08-10. A8, S7: a promoted covered payment goes behind the bank's older urgent
/// payment, so it waits while that one is uncovered (ADR-0008, ADR-0009). The A8
/// counterpart of SC-A01-17, added in Flow 10; it fails if the moved payment settles
/// because it is covered, past an older uncovered urgent head (S7).
#[test]
fn a_promoted_payment_waits_behind_an_older_uncovered_urgent_one() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let urgent = client.submit(setup.bank(0), setup.bank(1), &60, &URGENT);
    let normal = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);

    client.reprioritise(&normal, &URGENT);

    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(Reprioritised {
            id: normal,
            priority: URGENT,
        })]
    );
    assert_eq!(setup.queue(0, URGENT), std::vec![urgent, normal]);
    assert_eq!(client.payment(&normal).unwrap().status, Status::Queued);
    assert_eq!(client.queued_count(), 2);
    assert_eq!(setup.balances(), std::vec![50, 0]);
}

/// SC-A08-11. A8 has no cut-off: a payment queued long past its expiry time, but not yet
/// expired by anyone, can still be moved, keeping its place by age. As in the model, A8
/// has no time guard: a payment past its expiry stays queued until `expire` (A5) runs
/// (ADR-0015, as in `quint/settlement.qnt`), and the model's A18 close, which would have
/// rejected it, is gone under ADR-0013. Added in Flow 10; it fails if `reprioritise`
/// refuses a payment past its expiry.
#[test]
fn a_payment_past_its_expiry_can_still_be_reprioritised() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    setup.at(1_000);
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    setup.at(1_000 + 10 * default_config().expiry_secs);

    client.reprioritise(&id, &URGENT);

    let payment = client.payment(&id).unwrap();
    assert_eq!((payment.priority, payment.status), (URGENT, Status::Queued));
    assert_eq!(setup.queue(0, URGENT), std::vec![id]);
}

// ---------------------------------------------------------------------------------------
// A5 expire (ADR-0015, replacing τ_qc)

/// SC-A05-01. A5 after ADR-0015: once more than `expiry_secs` have passed since
/// submission, anyone may reject the payment. Its status becomes `Expired` (the model's
/// `rejected`) and it leaves its queue.
#[test]
fn a_payment_past_its_expiry_can_be_expired() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    setup.at(1_000);
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    setup.at(1_000 + default_config().expiry_secs + 1);

    client.expire(&id);

    assert_eq!(setup.our_events(), std::vec![setup.ev(Expired { id })]);
    assert_eq!(client.payment(&id).unwrap().status, Status::Expired);
    assert!(setup.queue(0, NORMAL).is_empty());
    assert_eq!(client.queued_count(), 0);
}

/// SC-A05-02. The boundary: exactly at `submitted_at + expiry_secs` the payment has not
/// expired (A5's guard is `t > τ`), so `NotExpired`. With CAP-88 two ledgers may share a
/// timestamp, and a strict comparison stays correct (handbook 09 §3).
#[test]
fn a_payment_exactly_at_its_expiry_has_not_expired() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    setup.at(1_000);
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);

    for time in [1_000, 1_000 + default_config().expiry_secs] {
        setup.at(time);
        assert_eq!(client.try_expire(&id), Err(Ok(Error::NotExpired)));
    }
    assert_eq!(client.payment(&id).unwrap().status, Status::Queued);
}

/// SC-A05-03. The expiry is a configuration value (ADR-0015): with a 10-second expiry, a
/// payment expires at its 11th second.
#[test]
fn the_expiry_is_configurable() {
    let setup = Setup::with_config(
        2,
        0,
        Config {
            expiry_secs: 10,
            ..default_config()
        },
    );
    let client = setup.client();
    setup.at(50);
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    setup.at(60);
    assert_eq!(client.try_expire(&id), Err(Ok(Error::NotExpired)));
    setup.at(61);
    client.expire(&id);
    assert_eq!(client.payment(&id).unwrap().status, Status::Expired);
}

/// SC-A05-04. ADR-0015's consequence: expiring an uncovered head releases the payment
/// behind it, in the same call (S9).
#[test]
fn expiring_the_head_releases_the_payment_behind_it() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let head = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    let behind = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    setup.at(default_config().expiry_secs + 1);

    client.expire(&head);

    assert_eq!(
        setup.our_events(),
        std::vec![
            setup.ev(Expired { id: head }),
            setup.ev(Settled {
                id: behind,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 10,
            }),
        ]
    );
    assert_eq!(setup.balances(), std::vec![40, 10]);
}

/// SC-A05-05. Each payment's expiry runs from its own submission: a later payment has
/// not expired when an earlier one has.
#[test]
fn each_payment_expires_from_its_own_submission() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let expiry = default_config().expiry_secs;
    setup.at(0);
    let early = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    setup.at(100);
    let late = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    setup.at(expiry + 1);
    client.expire(&early);
    assert_eq!(client.try_expire(&late), Err(Ok(Error::NotExpired)));
}

/// SC-A05-06. S3, S5: a settled payment never expires; `NotQueued`.
#[test]
fn a_settled_payment_cannot_be_expired() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    setup.at(default_config().expiry_secs + 1);
    assert_eq!(client.try_expire(&id), Err(Ok(Error::NotQueued)));
    assert_eq!(client.payment(&id).unwrap().status, Status::Settled);
}

/// SC-A05-07. S3: a revoked payment cannot be expired.
#[test]
fn a_revoked_payment_cannot_be_expired() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &10, &NORMAL);
    client.revoke(&id);
    setup.at(default_config().expiry_secs + 1);
    assert_eq!(client.try_expire(&id), Err(Ok(Error::NotQueued)));
}

/// SC-A05-08. An id that was never issued is `UnknownPayment`.
#[test]
fn expiring_an_unknown_payment_is_refused() {
    let setup = Setup::new(1, 0);
    assert_eq!(
        setup.client().try_expire(&3),
        Err(Ok(Error::UnknownPayment))
    );
}

/// SC-A05-10. A5: the expiry is a `u64` configuration value (ADR-0015), so
/// `submitted_at + expiry_secs` can exceed `u64::MAX`. An expiry that large never passes:
/// `NotExpired`, not an overflow trap. Added in Flow 11, since no other test sets an expiry
/// near the type's limit; it fails if the sum overflows instead of saturating.
#[test]
fn an_expiry_past_u64_max_never_passes_without_overflow() {
    let setup = Setup::with_config(
        2,
        0,
        Config {
            expiry_secs: u64::MAX,
            ..default_config()
        },
    );
    let client = setup.client();
    setup.at(1_000);
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    setup.at(u64::MAX);
    assert_eq!(client.try_expire(&id), Err(Ok(Error::NotExpired)));
    assert_eq!(client.payment(&id).unwrap().status, Status::Queued);
}
