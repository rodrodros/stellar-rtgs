//! Property tests: the safety invariants of §4.7 over random call sequences, with no
//! reference model (TESTING.md, "Property and state-machine tests"). The state machine in
//! `state_machine.rs` checks the outcomes; this file checks only what must hold whatever
//! they are, with inputs that reach the boundaries: zero, negative, one over a holding,
//! and the `i128` extremes.
//!
//! The model's business day (A17, A18, value dates, τ_rc, τ_qc) does not exist here: time
//! only moves forward (A19), payments expire from submission (ADR-0013, ADR-0015) and
//! repos turn into penalty repos at their term (ADR-0014). As in `quint/settlement.qnt`, a
//! payment past its expiry stays queued and can still settle until `expire` is called, so
//! S23 counts it as a candidate and S7 orders it like any other (see `state_machine.rs`).
//!
//! Two things this property demands, for whoever implements the contract:
//! - an offset must book each bank's net change, computed exactly (for example with the
//!   64-bit split of `reference::net_is_non_negative`). By S1 every end balance fits in
//!   `i128`, but neither booking payment by payment nor applying every debit first stays in
//!   range: both overflow at the `i128` limit (SC-A03-11, SC-A03-12);
//! - a refused SAC call, such as an `open_repo` mint that would overflow the contract's
//!   holding, must come back as a contract error, not a host abort.
use std::collections::BTreeMap;
use std::vec;
use std::vec::Vec;

use proptest::prelude::*;

use super::reference::{config, greatest_feasible_prefix};
use super::support::{default_config, Setup};
use crate::{Config, Error, Payment, Priority, RepoStatus, Status};

const N: usize = 3;
const FUNDING: i128 = 1_000;

/// A small queue cap, so that `QueueFull` is reached, and short expiry and repo terms, so
/// that `Tick` reaches them.
fn test_config() -> Config {
    Config {
        queue_cap: 6,
        expiry_secs: 100,
        repo_term_secs: 100,
        ..default_config()
    }
}

/// One call. Banks are indexes into `Setup::banks` (TESTING.md: generate plain values, not
/// `SorobanArbitrary`); actor `N` is the central bank.
#[derive(Clone, Debug)]
enum Op {
    Deposit(usize, i128),
    Withdraw(usize, i128),
    Submit(usize, usize, i128, Priority),
    Revoke(u64),
    Reprioritise(u64, Priority),
    Expire(u64),
    Tick(u64),
    SetCollateral(usize, i128),
    OpenRepo(usize, i128),
    Repay(usize, u64, i128),
    ConvertOverdue(u64),
}

fn amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        8 => 1i128..=400,
        1 => Just(0i128),
        1 => -5i128..0,
        1 => Just(FUNDING),
        1 => Just(FUNDING + 1),
        1 => Just(i128::MAX),
        1 => Just(i128::MAX / 2 + 1),
        1 => Just(i128::MIN),
    ]
}

fn priority() -> impl Strategy<Value = Priority> {
    prop_oneof![Just(Priority::Normal), Just(Priority::Urgent)]
}

/// Ids a little beyond what a run creates, so unknown ids are tried too.
fn id() -> impl Strategy<Value = u64> {
    0u64..24
}

/// Repo ids: a run opens a few repos at most, so a small range hits them often and still
/// tries unknown ones.
fn repo_id() -> impl Strategy<Value = u64> {
    0u64..4
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0..N, amount()).prop_map(|(b, a)| Op::Deposit(b, a)),
        1 => (0..N, amount()).prop_map(|(b, a)| Op::Withdraw(b, a)),
        5 => (0..N, 0..N, amount(), priority()).prop_map(|(f, t, a, p)| Op::Submit(f, t, a, p)),
        1 => id().prop_map(Op::Revoke),
        1 => (id(), priority()).prop_map(|(i, p)| Op::Reprioritise(i, p)),
        1 => id().prop_map(Op::Expire),
        2 => prop_oneof![Just(1u64), Just(100), Just(101), 0u64..=250].prop_map(Op::Tick),
        1 => (0..N, amount()).prop_map(|(b, a)| Op::SetCollateral(b, a)),
        2 => (0..N, amount()).prop_map(|(b, a)| Op::OpenRepo(b, a)),
        2 => (0..=N, repo_id(), amount()).prop_map(|(who, r, a)| Op::Repay(who, r, a)),
        2 => repo_id().prop_map(Op::ConvertOverdue),
    ]
}

/// Every failure must be one of the contract's own errors, never a host trap or a foreign
/// error code.
fn typed<T: core::fmt::Debug, C: core::fmt::Debug, I: core::fmt::Debug>(
    r: Result<Result<T, C>, Result<Error, I>>,
) -> Result<T, Error> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Err(Ok(e)) => Err(e),
        other => panic!("untyped outcome: {other:?}"),
    }
}

/// Every payment the contract has recorded, by id.
fn payments(s: &Setup) -> BTreeMap<u64, Payment> {
    let c = s.client();
    (0..)
        .map_while(|id| c.payment(&id).map(|p| (id, p)))
        .collect()
}

fn is_final(st: Status) -> bool {
    st != Status::Queued
}

/// `≺` within one bank (§4.5): urgent before normal, then by sequence number.
fn precedes(a: &Payment, b: &Payment) -> bool {
    let rank = |p: &Payment| (p.priority != Priority::Urgent, p.id);
    rank(a) < rank(b)
}

proptest! {
    #![proptest_config(config(64))]

    /// Every safety invariant the contract can break holds after every call, for any
    /// sequence of calls, valid or not:
    /// - S1 conservation: the tokens the contract holds equal the sum of the balances,
    ///   and that sum changes only by deposits, withdrawals, repo mints and burns
    ///   (ADR-0004, ADR-0011);
    /// - S2: no balance is negative (no credit line, ADR-0011; no limits, ADR-0018);
    /// - S3, S5: a final payment never changes status or settlement time (ADR-0005,
    ///   ADR-0006, ADR-0016);
    /// - S7 under F2: what settles in a call is, per bank, a `≺`-prefix of that bank's
    ///   queue (ADR-0008, ADR-0009);
    /// - S11: every recorded payment is positive, between two different banks, with its
    ///   own sequence number;
    /// - S9, S23: between calls nothing is covered and k* = 0 (ADR-0010);
    /// - S17, S21: `cr + ovn ≤ coll`, and `cr` and `ovn` are the outstanding intraday and
    ///   penalty repos (ADR-0011, ADR-0014);
    /// - the queue never holds more than `queue_cap` payments (ADR-0010).
    #[test]
    fn the_safety_invariants_hold_for_any_call_sequence(ops in prop::collection::vec(op(), 1..30)) {
        let cfg = test_config();
        let s = Setup::with_config(N, FUNDING, cfg.clone());
        let c = s.client();
        let actor = |who: usize| if who == N { s.cb.clone() } else { s.bank(who).clone() };
        // Ops are drawn before the run, so an `OpenRepo` rarely follows a `SetCollateral` for
        // the same bank. Every bank starts with collateral, so repos, repayments and penalty
        // repos are reached; `SetCollateral` can still take it to zero.
        for b in 0..N {
            typed(c.try_set_collateral(s.bank(b), &FUNDING)).unwrap();
        }
        // S1's right-hand side: the money that entered the ledger, less what left it.
        let mut issued: i128 = 0;
        let mut before = payments(&s);
        let mut now = 0u64;

        for op in ops {
            match op {
                Op::Deposit(b, a) => {
                    if typed(c.try_deposit(s.bank(b), &a)).is_ok() {
                        issued += a;
                    }
                }
                Op::Withdraw(b, a) => {
                    if typed(c.try_withdraw(s.bank(b), &a)).is_ok() {
                        issued -= a;
                    }
                }
                Op::Submit(f, t, a, p) => {
                    let _ = typed(c.try_submit(s.bank(f), s.bank(t), &a, &p));
                }
                Op::Revoke(id) => {
                    let _ = typed(c.try_revoke(&id));
                }
                Op::Reprioritise(id, p) => {
                    let _ = typed(c.try_reprioritise(&id, &p));
                }
                Op::Expire(id) => {
                    let _ = typed(c.try_expire(&id));
                }
                Op::Tick(dt) => {
                    now += dt;
                    s.at(now);
                }
                Op::SetCollateral(b, v) => {
                    let _ = typed(c.try_set_collateral(s.bank(b), &v));
                }
                Op::OpenRepo(b, a) => {
                    if typed(c.try_open_repo(s.bank(b), &a)).is_ok() {
                        issued += a;
                    }
                }
                Op::Repay(who, r, a) => {
                    if typed(c.try_repay(&actor(who), &r, &a)).is_ok() {
                        issued -= a;
                    }
                }
                Op::ConvertOverdue(r) => {
                    let _ = typed(c.try_convert_overdue(&r));
                }
            }

            // S1, S2.
            s.assert_conserved();
            prop_assert_eq!(s.balances().iter().sum::<i128>(), issued, "S1");

            let after = payments(&s);
            // S11.
            for (id, p) in &after {
                prop_assert_eq!(p.id, *id, "S11: id");
                prop_assert!(p.amount > 0, "S11: amount {}", p.amount);
                prop_assert!(p.from != p.to, "S11: payment {} to itself", id);
                prop_assert_eq!(p.status == Status::Settled, p.settled_at.is_some(), "settled_at of {}", id);
            }
            // S3, S5: final stays final, unchanged; no payment disappears.
            for (id, p) in &before {
                let q = after.get(id);
                prop_assert!(q.is_some(), "payment {} disappeared", id);
                if is_final(p.status) {
                    prop_assert_eq!(Some(p), q, "S3: final payment {} changed", id);
                }
            }
            // S7 under F2: a payment that settled in this call precedes, in its bank's `≺`,
            // every payment of that bank still queued.
            let newly: Vec<&Payment> = after
                .values()
                .filter(|p| p.status == Status::Settled)
                .filter(|p| before.get(&p.id).is_none_or(|b| b.status == Status::Queued))
                .collect();
            for p in &newly {
                for q in after.values().filter(|q| q.status == Status::Queued && q.from == p.from) {
                    prop_assert!(precedes(p, q), "S7: {} settled ahead of {}", p.id, q.id);
                }
            }
            // The queue views agree with the statuses, in `≺` order, under the cap.
            let queued = after.values().filter(|p| p.status == Status::Queued).count();
            prop_assert_eq!(c.queued_count() as usize, queued);
            prop_assert!(queued <= cfg.queue_cap as usize, "queue over its cap");
            let mut candidates = std::vec![];
            for b in 0..N {
                let mut q = s.queue(b, Priority::Urgent);
                q.extend(s.queue(b, Priority::Normal));
                let expected: Vec<u64> = {
                    let mut mine: Vec<&Payment> = after
                        .values()
                        .filter(|p| p.status == Status::Queued && &p.from == s.bank(b))
                        .collect();
                    mine.sort_by_key(|p| (p.priority != Priority::Urgent, p.id));
                    mine.iter().map(|p| p.id).collect()
                };
                prop_assert_eq!(&q, &expected, "queue of bank {}", b);
                candidates.push(
                    q.iter()
                        .map(|id| {
                            let p = &after[id];
                            (s.banks.iter().position(|x| *x == p.to).unwrap(), p.amount)
                        })
                        .collect::<Vec<_>>(),
                );
            }
            // S9, S23: at rest. No head is covered and the greatest feasible prefix is 0.
            let k = greatest_feasible_prefix(&s.balances(), &candidates);
            prop_assert!(k.iter().all(|x| *x == 0), "S23: k* = {:?} between calls", k);

            // S17, S21, and `cr`/`ovn` match the repos.
            for b in 0..N {
                let cr = c.credit(s.bank(b));
                prop_assert!(cr.cr >= 0 && cr.ovn >= 0 && cr.coll >= 0, "credit {:?}", cr);
                prop_assert!(cr.cr.checked_add(cr.ovn).is_some_and(|t| t <= cr.coll), "S21: {:?}", cr);
                let (mut intraday, mut penalty) = (0i128, 0i128);
                for repo in (0..).map_while(|id| c.repo(&id)).filter(|r| &r.bank == s.bank(b)) {
                    prop_assert!(repo.outstanding >= 0 && repo.outstanding <= repo.amount, "repo {:?}", repo);
                    prop_assert_eq!(repo.status == RepoStatus::Repaid, repo.outstanding == 0, "repo {:?}", repo);
                    match repo.status {
                        RepoStatus::Intraday => intraday += repo.outstanding,
                        RepoStatus::Penalty => penalty += repo.outstanding,
                        RepoStatus::Repaid => {}
                    }
                }
                prop_assert_eq!((cr.cr, cr.ovn), (intraday, penalty), "credit of bank {}", b);
            }
            before = after;
        }
    }
}
