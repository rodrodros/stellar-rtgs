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
use soroban_sdk::Address;

use super::reference::{config, greatest_feasible_prefix};
use super::support::{default_config, Setup};
use crate::{Config, Error, Payment, Priority, RepoStatus, Status};

const BANKS: usize = 3;
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
/// `SorobanArbitrary`); actor `BANKS` is the central bank.
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
        3 => (0..BANKS, amount()).prop_map(|(bank, amount)| Op::Deposit(bank, amount)),
        1 => (0..BANKS, amount()).prop_map(|(bank, amount)| Op::Withdraw(bank, amount)),
        5 => (0..BANKS, 0..BANKS, amount(), priority())
            .prop_map(|(from, to, amount, priority)| Op::Submit(from, to, amount, priority)),
        1 => id().prop_map(Op::Revoke),
        1 => (id(), priority()).prop_map(|(id, priority)| Op::Reprioritise(id, priority)),
        1 => id().prop_map(Op::Expire),
        2 => prop_oneof![Just(1u64), Just(100), Just(101), 0u64..=250].prop_map(Op::Tick),
        1 => (0..BANKS, amount()).prop_map(|(bank, amount)| Op::SetCollateral(bank, amount)),
        2 => (0..BANKS, amount()).prop_map(|(bank, amount)| Op::OpenRepo(bank, amount)),
        2 => (0..=BANKS, repo_id(), amount())
            .prop_map(|(who, repo, amount)| Op::Repay(who, repo, amount)),
        2 => repo_id().prop_map(Op::ConvertOverdue),
    ]
}

/// Every failure must be one of the contract's own errors, never a host trap or a foreign
/// error code.
fn typed<T: core::fmt::Debug, C: core::fmt::Debug, I: core::fmt::Debug>(
    result: Result<Result<T, C>, Result<Error, I>>,
) -> Result<T, Error> {
    match result {
        Ok(Ok(value)) => Ok(value),
        Err(Ok(err)) => Err(err),
        other => panic!("untyped outcome: {other:?}"),
    }
}

/// Every payment the contract has recorded, by id.
fn payments(setup: &Setup) -> BTreeMap<u64, Payment> {
    let client = setup.client();
    (0..)
        .map_while(|id| client.payment(&id).map(|payment| (id, payment)))
        .collect()
}

fn is_final(st: Status) -> bool {
    st != Status::Queued
}

/// A payment's place in its bank's `≺` (§4.5): urgent before normal, then by sequence
/// number.
fn rank(priority: Priority, id: u64) -> (bool, u64) {
    (priority != Priority::Urgent, id)
}

fn precedes(first: &Payment, second: &Payment) -> bool {
    rank(first.priority, first.id) < rank(second.priority, second.id)
}

/// S7 under F2: a payment that settled between `before` and `after` precedes, in its
/// bank's `≺`, every payment of that bank still queued.
fn settled_in_order(
    before: &BTreeMap<u64, Payment>,
    after: &BTreeMap<u64, Payment>,
) -> Result<(), TestCaseError> {
    let newly = after
        .values()
        .filter(|payment| payment.status == Status::Settled)
        .filter(|payment| {
            before
                .get(&payment.id)
                .is_none_or(|earlier| earlier.status == Status::Queued)
        });
    for payment in newly {
        for waiting in after
            .values()
            .filter(|waiting| waiting.status == Status::Queued && waiting.from == payment.from)
        {
            prop_assert!(
                precedes(payment, waiting),
                "S7: {} settled ahead of {}",
                payment.id,
                waiting.id
            );
        }
    }
    Ok(())
}

/// The ids bank `b` has queued, in `≺` order: what its `queue` views, urgent then normal,
/// must list.
fn queued_in_order(setup: &Setup, payments: &BTreeMap<u64, Payment>, bank: usize) -> Vec<u64> {
    let mut mine: Vec<&Payment> = payments
        .values()
        .filter(|payment| payment.status == Status::Queued && &payment.from == setup.bank(bank))
        .collect();
    mine.sort_by_key(|payment| rank(payment.priority, payment.id));
    mine.iter().map(|payment| payment.id).collect()
}

/// A sum of `i128` terms kept exactly: each term is split into 64-bit halves, whose sums
/// cannot overflow, as in `reference::net_is_non_negative`. S4's booking sums can exceed
/// `i128` once an offset settles payments at the `i128` limit.
#[derive(Clone, Default)]
struct ExactSum {
    hi: i128,
    lo: i128,
}

impl ExactSum {
    const HALF: i128 = 1 << 64;

    fn add(&mut self, amount: i128) {
        self.hi += amount.div_euclid(Self::HALF);
        self.lo += amount.rem_euclid(Self::HALF);
    }

    fn sub(&mut self, amount: i128) {
        self.hi -= amount.div_euclid(Self::HALF);
        self.lo -= amount.rem_euclid(Self::HALF);
    }

    /// The sum is `hi · 2^64 + lo`; with `lo` carried into [0, 2^64), it is zero exactly
    /// when both halves are.
    fn is_zero(&self) -> bool {
        self.hi + self.lo.div_euclid(Self::HALF) == 0 && self.lo.rem_euclid(Self::HALF) == 0
    }
}

/// Whether bank `b` has a payment queued ahead, in `≺`, of a new payment `id` of priority
/// `p`: if so, S7 keeps that payment from settling at once.
fn queued_ahead(
    setup: &Setup,
    payments: &BTreeMap<u64, Payment>,
    bank: usize,
    priority: Priority,
    id: u64,
) -> bool {
    payments
        .values()
        .filter(|queued| queued.status == Status::Queued && &queued.from == setup.bank(bank))
        .any(|queued| rank(queued.priority, queued.id) < rank(priority, id))
}

/// Only deposit, withdraw and submit, for the properties of submission alone.
fn submission_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        2 => (0..BANKS, amount()).prop_map(|(bank, amount)| Op::Deposit(bank, amount)),
        1 => (0..BANKS, amount()).prop_map(|(bank, amount)| Op::Withdraw(bank, amount)),
        6 => (0..BANKS, 0..BANKS, amount(), priority())
            .prop_map(|(from, to, amount, priority)| Op::Submit(from, to, amount, priority)),
    ]
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
        let setup = Setup::with_config(BANKS, FUNDING, cfg.clone());
        let client = setup.client();
        let actor = |who: usize| {
            if who == BANKS { setup.cb.clone() } else { setup.bank(who).clone() }
        };
        // Ops are drawn before the run, so an `OpenRepo` rarely follows a `SetCollateral` for
        // the same bank. Every bank starts with collateral, so repos, repayments and penalty
        // repos are reached; `SetCollateral` can still take it to zero.
        for bank in 0..BANKS {
            typed(client.try_set_collateral(setup.bank(bank), &FUNDING)).unwrap();
        }
        // S1's right-hand side: the money that entered the ledger, less what left it.
        let mut issued: i128 = 0;
        let mut before = payments(&setup);
        let mut now = 0u64;

        for op in ops {
            match op {
                Op::Deposit(bank, amount) => {
                    if typed(client.try_deposit(setup.bank(bank), &amount)).is_ok() {
                        issued += amount;
                    }
                }
                Op::Withdraw(bank, amount) => {
                    if typed(client.try_withdraw(setup.bank(bank), &amount)).is_ok() {
                        issued -= amount;
                    }
                }
                Op::Submit(from, to, amount, priority) => {
                    let _ = typed(client.try_submit(setup.bank(from), setup.bank(to), &amount, &priority));
                }
                Op::Revoke(id) => {
                    let _ = typed(client.try_revoke(&id));
                }
                Op::Reprioritise(id, priority) => {
                    let _ = typed(client.try_reprioritise(&id, &priority));
                }
                Op::Expire(id) => {
                    let _ = typed(client.try_expire(&id));
                }
                Op::Tick(dt) => {
                    now += dt;
                    setup.at(now);
                }
                Op::SetCollateral(bank, value) => {
                    let _ = typed(client.try_set_collateral(setup.bank(bank), &value));
                }
                Op::OpenRepo(bank, amount) => {
                    if typed(client.try_open_repo(setup.bank(bank), &amount)).is_ok() {
                        issued += amount;
                    }
                }
                Op::Repay(who, repo, amount) => {
                    if typed(client.try_repay(&actor(who), &repo, &amount)).is_ok() {
                        issued -= amount;
                    }
                }
                Op::ConvertOverdue(repo) => {
                    let _ = typed(client.try_convert_overdue(&repo));
                }
            }

            // S1, S2.
            setup.assert_conserved();
            prop_assert_eq!(setup.balances().iter().sum::<i128>(), issued, "S1");

            let after = payments(&setup);
            // S11.
            for (id, payment) in &after {
                prop_assert_eq!(payment.id, *id, "S11: id");
                prop_assert!(payment.amount > 0, "S11: amount {}", payment.amount);
                prop_assert!(payment.from != payment.to, "S11: payment {} to itself", id);
                prop_assert_eq!(
                    payment.status == Status::Settled,
                    payment.settled_at.is_some(),
                    "settled_at of {}", id
                );
            }
            // S3, S5: final stays final, unchanged; no payment disappears.
            for (id, payment) in &before {
                let current = after.get(id);
                prop_assert!(current.is_some(), "payment {} disappeared", id);
                if is_final(payment.status) {
                    prop_assert_eq!(Some(payment), current, "S3: final payment {} changed", id);
                }
            }
            // S7 under F2.
            settled_in_order(&before, &after)?;
            // The queue views agree with the statuses, in `≺` order, under the cap.
            let queued = after.values().filter(|payment| payment.status == Status::Queued).count();
            prop_assert_eq!(client.queued_count() as usize, queued);
            prop_assert!(queued <= cfg.queue_cap as usize, "queue over its cap");
            let mut candidates = std::vec![];
            for bank in 0..BANKS {
                let mut queue = setup.queue(bank, Priority::Urgent);
                queue.extend(setup.queue(bank, Priority::Normal));
                prop_assert_eq!(&queue, &queued_in_order(&setup, &after, bank), "queue of bank {}", bank);
                candidates.push(
                    queue.iter()
                        .map(|id| {
                            let payment = &after[id];
                            (setup.banks.iter().position(|x| *x == payment.to).unwrap(), payment.amount)
                        })
                        .collect::<Vec<_>>(),
                );
            }
            // S9, S23: at rest. No head is covered and the greatest feasible prefix is 0.
            let prefix = greatest_feasible_prefix(&setup.balances(), &candidates);
            prop_assert!(prefix.iter().all(|x| *x == 0), "S23: k* = {:?} between calls", prefix);

            // S17, S21, and `cr`/`ovn` match the repos.
            for bank in 0..BANKS {
                let cr = client.credit(setup.bank(bank));
                prop_assert!(cr.cr >= 0 && cr.ovn >= 0 && cr.coll >= 0, "credit {:?}", cr);
                prop_assert!(
                    cr.cr.checked_add(cr.ovn).is_some_and(|total| total <= cr.coll),
                    "S21: {:?}", cr
                );
                let (mut intraday, mut penalty) = (0i128, 0i128);
                for repo in (0..)
                    .map_while(|id| client.repo(&id))
                    .filter(|repo| &repo.bank == setup.bank(bank))
                {
                    prop_assert!(repo.outstanding >= 0 && repo.outstanding <= repo.amount, "repo {:?}", repo);
                    prop_assert_eq!(repo.status == RepoStatus::Repaid, repo.outstanding == 0, "repo {:?}", repo);
                    match repo.status {
                        RepoStatus::Intraday => intraday += repo.outstanding,
                        RepoStatus::Penalty => penalty += repo.outstanding,
                        RepoStatus::Repaid => {}
                    }
                }
                prop_assert_eq!((cr.cr, cr.ovn), (intraday, penalty), "credit of bank {}", bank);
            }
            before = after;
        }
    }

    /// Submission keeps each bank's queue discipline, over any sequence of deposits,
    /// withdrawals and submissions, valid or not:
    /// - S7 under F2: a payment settles only ahead of none of its bank's queued payments
    ///   in `≺`; within a priority, strictly first in, first out (ADR-0008), and a queued
    ///   urgent payment blocks the bank's normal ones (ADR-0009);
    /// - A1, A2: a payment that is covered, with nothing of its sender's queued ahead of it
    ///   in `≺`, settles in its own submission, never waits (ADR-0010);
    /// - the queue views list each bank's queued payments in `≺` order;
    /// - S1, S2: conservation, and no negative balance (ADR-0004, ADR-0011).
    ///
    /// A refused call, `QueueFull` included, is skipped. The calls need no later entry
    /// point, so this checks the queue discipline before SC-P-01 can.
    #[test]
    fn submissions_keep_each_banks_queue_in_order(ops in prop::collection::vec(submission_op(), 1..30)) {
        let setup = Setup::new(BANKS, FUNDING);
        let client = setup.client();
        let mut before = payments(&setup);

        for op in ops {
            match op {
                Op::Deposit(bank, amount) => {
                    let _ = typed(client.try_deposit(setup.bank(bank), &amount));
                }
                Op::Withdraw(bank, amount) => {
                    let _ = typed(client.try_withdraw(setup.bank(bank), &amount));
                }
                Op::Submit(from, to, amount, priority) => {
                    let id = before.len() as u64;
                    let ahead = queued_ahead(&setup, &before, from, priority, id);
                    let covered = client.balance(setup.bank(from)) >= amount;
                    let submitted =
                        typed(client.try_submit(setup.bank(from), setup.bank(to), &amount, &priority));
                    if submitted.is_ok() && covered && !ahead {
                        prop_assert_eq!(
                            client.payment(&id).map(|payment| payment.status),
                            Some(Status::Settled),
                            "A2: {} waits", id
                        );
                    }
                }
                _ => unreachable!(),
            }

            setup.assert_conserved();
            let after = payments(&setup);
            settled_in_order(&before, &after)?;
            for bank in 0..BANKS {
                let mut queue = setup.queue(bank, Priority::Urgent);
                queue.extend(setup.queue(bank, Priority::Normal));
                prop_assert_eq!(&queue, &queued_in_order(&setup, &after, bank), "queue of bank {}", bank);
            }
            before = after;
        }
    }

    /// No payment queues past the queue cap, over any sequence of deposits, withdrawals
    /// and submissions, valid or not (ADR-0010):
    /// - A1: a valid payment made while `queue_cap` payments are queued, that would not
    ///   settle at once by cover, is refused with `QueueFull` or settles in its own
    ///   submission: it never queues. Any other valid payment is accepted, so a payment
    ///   covered with nothing of its sender's queued ahead of it in `≺` (S7, ADR-0008) is
    ///   never refused;
    /// - A1: an invalid payment gets its own guard's error, `InvalidAmount` or
    ///   `SameAccount` (either, if it breaks both: the order is left open), never
    ///   `QueueFull`;
    /// - A1, S11: a refusal moves nothing, records nothing and uses no id;
    /// - the payments queued, counted from their records, never exceed `queue_cap`, and
    ///   `queued_count` counts them;
    /// - S7 under F2: what settles, at the cap or not, precedes in `≺` every payment its
    ///   sender still queues (ADR-0008, ADR-0009);
    /// - S4: every balance moves only by the call's own deposit or withdrawal and the
    ///   payments that settle in it, so what settles at the cap is booked. The sums are
    ///   exact, so this holds at the `i128` limit once an offset settles there;
    /// - S1, S2: conservation, and no negative balance (ADR-0004, ADR-0011), so what
    ///   settles at the cap is paid for.
    ///
    /// The cap is 3, so that a run reaches it often. The calls need no later entry point,
    /// so this checks the cap before SC-P-01 can. It leaves open whether the cap refuses a
    /// payment that an offset would settle (Flow 13, README): `quint/settlement.qnt`
    /// settles it. Once that is decided, Flow 13 narrows this branch to the answer.
    #[test]
    fn submissions_never_queue_past_the_cap(ops in prop::collection::vec(submission_op(), 1..30)) {
        let cap = 3;
        let setup = Setup::with_config(BANKS, FUNDING, Config { queue_cap: cap, ..default_config() });
        let client = setup.client();
        let queued = |ps: &BTreeMap<u64, Payment>| {
            ps.values().filter(|payment| payment.status == Status::Queued).count() as u32
        };
        let mut before = payments(&setup);

        for op in ops {
            let balances = setup.balances();
            // Per bank, the balance before, plus its funding and the payments that settle,
            // minus the balance after: S4 holds when every one is zero.
            let mut drift: Vec<ExactSum> = balances
                .iter()
                .map(|&balance| {
                    let mut delta = ExactSum::default();
                    delta.add(balance);
                    delta
                })
                .collect();
            match op {
                Op::Deposit(bank, amount) => {
                    if typed(client.try_deposit(setup.bank(bank), &amount)).is_ok() {
                        drift[bank].add(amount);
                    }
                }
                Op::Withdraw(bank, amount) => {
                    if typed(client.try_withdraw(setup.bank(bank), &amount)).is_ok() {
                        drift[bank].sub(amount);
                    }
                }
                Op::Submit(from, to, amount, priority) => {
                    let id = before.len() as u64;
                    let ahead = queued_ahead(&setup, &before, from, priority, id);
                    let settles = !ahead && client.balance(setup.bank(from)) >= amount;
                    let full = queued(&before) >= cap;
                    let result =
                        typed(client.try_submit(setup.bank(from), setup.bank(to), &amount, &priority));
                    if amount > 0 && from != to {
                        if full && !settles {
                            let settled = client.payment(&id).map(|payment| payment.status)
                                == Some(Status::Settled);
                            prop_assert!(
                                result == Err(Error::QueueFull) || (result == Ok(id) && settled),
                                "{} would queue past the cap: {:?}", id, result
                            );
                        } else {
                            prop_assert_eq!(result, Ok(id), "{} refused", id);
                        }
                    } else {
                        // When both guards fail, either error will do: the order is left open.
                        let ok = match result {
                            Err(Error::InvalidAmount) => amount <= 0,
                            Err(Error::SameAccount) => from == to,
                            _ => false,
                        };
                        prop_assert!(ok, "A1's guards come before the cap: {:?}", result);
                    }
                    if result.is_err() {
                        prop_assert_eq!(&payments(&setup), &before, "a refusal records nothing");
                        prop_assert_eq!(&setup.balances(), &balances, "a refusal moves nothing");
                    }
                }
                _ => unreachable!(),
            }

            setup.assert_conserved();
            let after = payments(&setup);
            let bank = |address: &Address| setup.banks.iter().position(|x| x == address).unwrap();
            for payment in after.values().filter(|payment| {
                payment.status == Status::Settled
                    && before.get(&payment.id).map(|earlier| earlier.status) != Some(Status::Settled)
            }) {
                drift[bank(&payment.from)].sub(payment.amount);
                drift[bank(&payment.to)].add(payment.amount);
            }
            for (delta, balance) in drift.iter_mut().zip(setup.balances()) {
                delta.sub(balance);
            }
            prop_assert!(
                drift.iter().all(ExactSum::is_zero),
                "S4: balances move only by funding and settlements: {:?} to {:?}", balances, setup.balances()
            );
            settled_in_order(&before, &after)?;
            prop_assert!(queued(&after) <= cap, "queue over its cap");
            prop_assert_eq!(client.queued_count(), queued(&after), "queued_count");
            before = after;
        }
    }

    /// The eager closure leaves every queue at rest, over any sequence of deposits,
    /// withdrawals and submissions, valid or not (§4.6; ADR-0010):
    /// - A2, S9, gross: between calls no bank's head in `≺` is covered, so a deposit, or a
    ///   submission that settles and credits its receiver, settles every covered head and
    ///   follows the cascade in the same call;
    /// - S7 under F2: what settles in a call is, per bank, a `≺`-prefix of its queue, so
    ///   an uncovered urgent head blocks the bank's normal payments (ADR-0008, ADR-0009);
    /// - A11: a withdrawal settles nothing, as SC-A02-06 pins. A withdrawal only lowers a
    ///   balance and the queues are at rest before it, so this check restates that test;
    /// - S3, S5: a settled payment never changes (ADR-0005, ADR-0006);
    /// - `queued_count` counts the payments queued, from their records;
    /// - S1, S2: conservation, and no negative balance (ADR-0004, ADR-0011).
    ///
    /// A refused call, `QueueFull` included, is skipped. The calls need no later entry
    /// point, so this checks the closure before SC-P-01 can. It checks gross rest alone,
    /// not k* = 0, so it stays valid once Flow 13's offset exists: S9 still demands that
    /// no head is covered between calls, as SC-P-01 does.
    #[test]
    fn the_closure_leaves_every_queue_at_rest(ops in prop::collection::vec(submission_op(), 1..30)) {
        let setup = Setup::new(BANKS, FUNDING);
        let client = setup.client();
        let mut before = payments(&setup);

        for op in ops {
            let withdrawal = matches!(op, Op::Withdraw(..));
            match op {
                Op::Deposit(bank, amount) => {
                    let _ = typed(client.try_deposit(setup.bank(bank), &amount));
                }
                Op::Withdraw(bank, amount) => {
                    let _ = typed(client.try_withdraw(setup.bank(bank), &amount));
                }
                Op::Submit(from, to, amount, priority) => {
                    let _ = typed(client.try_submit(setup.bank(from), setup.bank(to), &amount, &priority));
                }
                _ => unreachable!(),
            }

            setup.assert_conserved();
            let after = payments(&setup);
            if withdrawal {
                prop_assert_eq!(&after, &before, "A11: a withdrawal settled something");
            }
            for (id, payment) in &before {
                if is_final(payment.status) {
                    prop_assert_eq!(Some(payment), after.get(id), "S3: final payment {} changed", id);
                }
            }
            settled_in_order(&before, &after)?;
            let queued = after.values().filter(|payment| payment.status == Status::Queued).count();
            prop_assert_eq!(client.queued_count() as usize, queued, "queued_count");
            for bank in 0..BANKS {
                if let Some(head) = queued_in_order(&setup, &after, bank).first() {
                    let (amount, balance) = (after[head].amount, client.balance(setup.bank(bank)));
                    prop_assert!(
                        amount > balance,
                        "S9: bank {}'s head {} ({}) is covered by {}", bank, head, amount, balance
                    );
                }
            }
            before = after;
        }
    }
}
