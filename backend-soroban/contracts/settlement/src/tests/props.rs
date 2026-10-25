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

/// A call of the revocation property: a deposit, withdrawal, submission, time step or
/// revocation by id, or one resolved against the state when it runs:
/// - `Block(from, to, over, under, priority)` submits from `from` a payment `over` more
///   than its balance, then one `under` less, which S7 queues behind the first: the queue
///   a revocation of its head releases;
/// - `RevokeHead` revokes a bank's head in `≺`, picked by `Index` among the heads with a
///   covered payment behind them if there are any, else among every head;
/// - `RevokeQueued` revokes any queued payment, picked by `Index`.
#[derive(Clone, Debug)]
enum RevocationOp {
    Call(Op),
    Block(usize, usize, i128, i128, Priority),
    RevokeHead(prop::sample::Index),
    RevokeQueued(prop::sample::Index),
}

/// Calls aimed at the queues. Left to random amounts, a bank rarely has a covered payment
/// queued behind an uncovered head, and an id drawn blindly rarely hits that head, so a
/// revocation that skips the closure goes unseen. Blind ids, a few of the calls, still
/// reach `UnknownPayment` and `NotQueued`. Time steps reach past the
/// default expiry, so that a payment is revoked after it (ADR-0016: no cut-off).
fn revocation_op() -> impl Strategy<Value = RevocationOp> {
    use RevocationOp::*;
    let expiry = default_config().expiry_secs;
    prop_oneof![
        2 => (0..BANKS, amount()).prop_map(|(bank, amount)| Call(Op::Deposit(bank, amount))),
        1 => (0..BANKS, amount()).prop_map(|(bank, amount)| Call(Op::Withdraw(bank, amount))),
        3 => (0..BANKS, 0..BANKS, amount(), priority())
            .prop_map(|(from, to, amount, priority)| Call(Op::Submit(from, to, amount, priority))),
        2 => (0..BANKS, 0..BANKS, 1i128..=100, 0i128..=100, priority())
            .prop_map(|(from, to, over, under, priority)| Block(from, to, over, under, priority)),
        1 => prop_oneof![Just(1u64), Just(expiry + 1), 0u64..=2 * expiry].prop_map(|step| Call(Op::Tick(step))),
        1 => id().prop_map(|id| Call(Op::Revoke(id))),
        2 => any::<prop::sample::Index>().prop_map(RevokeHead),
        1 => any::<prop::sample::Index>().prop_map(RevokeQueued),
    ]
}

/// A6, A8, S3: a call changes a payment queued before it only by settling it, apart from
/// the one it revokes or reprioritises, `acted_on`. A settled payment keeps every other
/// field.
fn queued_kept_or_settled(
    before: &BTreeMap<u64, Payment>,
    after: &BTreeMap<u64, Payment>,
    acted_on: Option<u64>,
) -> Result<(), TestCaseError> {
    let untouched = before
        .values()
        .filter(|payment| payment.status == Status::Queued && Some(payment.id) != acted_on);
    for payment in untouched {
        let now = &after[&payment.id];
        let settled = Payment {
            status: Status::Settled,
            settled_at: now.settled_at,
            ..payment.clone()
        };
        prop_assert!(
            now == payment || (now == &settled && now.settled_at.is_some()),
            "A6, A8: queued payment {} changed to {:?}",
            payment.id,
            now
        );
    }
    Ok(())
}

/// A6, A8: a call that moves no money of its own changes each balance from `balances`
/// only by the payments that settle in it, between `before` and `after`.
fn booked_only_settlements(
    setup: &Setup,
    balances: &[i128],
    before: &BTreeMap<u64, Payment>,
    after: &BTreeMap<u64, Payment>,
) -> Result<(), TestCaseError> {
    let index = |address: &Address| setup.banks.iter().position(|bank| bank == address).unwrap();
    let mut expected = balances.to_vec();
    let newly = after.values().filter(|payment| {
        payment.status == Status::Settled && before[&payment.id].status == Status::Queued
    });
    for payment in newly {
        expected[index(&payment.from)] -= payment.amount;
        expected[index(&payment.to)] += payment.amount;
    }
    prop_assert_eq!(setup.balances(), expected, "moved money of its own");
    Ok(())
}

/// The checks every call of SC-P-13 and SC-P-14 must pass, `acted_on` being the payment it
/// revoked or reprioritised: final payments unchanged (S3, S5); every other queued payment
/// unchanged or settled; S7's order of what settled; `queued_count` from the records; the
/// queue views in `≺` order, so ids within each priority ascend (S7, ADR-0009); and no
/// bank's head in `≺` covered (S9, gross).
fn queues_at_rest_in_order(
    setup: &Setup,
    before: &BTreeMap<u64, Payment>,
    after: &BTreeMap<u64, Payment>,
    acted_on: Option<u64>,
) -> Result<(), TestCaseError> {
    let client = setup.client();
    for (id, payment) in before {
        if is_final(payment.status) {
            prop_assert_eq!(
                Some(payment),
                after.get(id),
                "S3: final payment {} changed",
                id
            );
        }
    }
    queued_kept_or_settled(before, after, acted_on)?;
    settled_in_order(before, after)?;
    let queued = after
        .values()
        .filter(|payment| payment.status == Status::Queued)
        .count();
    prop_assert_eq!(client.queued_count() as usize, queued, "queued_count");
    for bank in 0..BANKS {
        let in_order = queued_in_order(setup, after, bank);
        let mut views = setup.queue(bank, Priority::Urgent);
        views.extend(setup.queue(bank, Priority::Normal));
        prop_assert_eq!(&views, &in_order, "queue of bank {}", bank);
        if let Some(head) = in_order.first() {
            let (amount, balance) = (after[head].amount, client.balance(setup.bank(bank)));
            prop_assert!(
                amount > balance,
                "S9: bank {}'s head {} ({}) is covered by {}",
                bank,
                head,
                amount,
                balance
            );
        }
    }
    Ok(())
}

/// A call of the reprioritisation property: a deposit, withdrawal, submission, time step,
/// revocation or reprioritisation by id, or one resolved against the state when it runs:
/// - `Block` as in `RevocationOp`: a covered payment queued behind an uncovered one;
/// - `MoveAimed` moves to the other priority a payment whose move can release a queue,
///   picked by `Index`: a covered normal payment behind its bank's head, which a
///   promotion may settle, or an uncovered urgent payment ahead of its bank's normal
///   ones, which a demotion may release. With none, any queued payment;
/// - `MoveQueued` moves any queued payment, picked by `Index`, to `Priority`: half the
///   time its own, which is `SamePriority`;
/// - `RevokeQueued` revokes any queued payment, picked by `Index`;
/// - `MoveFinal` moves a settled or revoked payment, picked by `Index`, to `Priority`:
///   `NotQueued` whichever it is. A blind id seldom lands on a revoked payment.
#[derive(Clone, Debug)]
enum ReprioritisationOp {
    Call(Op),
    Block(usize, usize, i128, i128, Priority),
    MoveAimed(prop::sample::Index),
    MoveQueued(prop::sample::Index, Priority),
    RevokeQueued(prop::sample::Index),
    MoveFinal(prop::sample::Index, Priority),
}

/// The queued payments whose move to the other priority can release a queue: a covered
/// normal payment behind its bank's head, which a promotion may settle, or an uncovered
/// urgent payment ahead of its bank's normal ones, which a demotion may release. `queues`
/// holds each bank's queued ids in `≺` order, read from `known`.
fn releasing_moves(setup: &Setup, known: &BTreeMap<u64, Payment>, queues: &[Vec<u64>]) -> Vec<u64> {
    let client = setup.client();
    let mut moves = Vec::new();
    for (bank, queue) in queues.iter().enumerate() {
        let balance = client.balance(setup.bank(bank));
        let has_normal = queue
            .iter()
            .any(|id| known[id].priority == Priority::Normal);
        for (place, id) in queue.iter().enumerate() {
            let payment = &known[id];
            let promotes =
                payment.priority == Priority::Normal && place > 0 && payment.amount <= balance;
            let demotes =
                payment.priority == Priority::Urgent && has_normal && payment.amount > balance;
            if promotes || demotes {
                moves.push(*id);
            }
        }
    }
    moves
}

/// Calls aimed at the queues, for the same reason as `revocation_op`: a blind id rarely
/// hits a payment whose move releases anything. Blind ids still reach `UnknownPayment`,
/// `NotQueued` and `SamePriority`. Time steps reach past the default expiry, so that a
/// payment is moved after it: A8 has no cut-off.
fn reprioritisation_op() -> impl Strategy<Value = ReprioritisationOp> {
    use ReprioritisationOp::*;
    let expiry = default_config().expiry_secs;
    prop_oneof![
        2 => (0..BANKS, amount()).prop_map(|(bank, amount)| Call(Op::Deposit(bank, amount))),
        1 => (0..BANKS, amount()).prop_map(|(bank, amount)| Call(Op::Withdraw(bank, amount))),
        3 => (0..BANKS, 0..BANKS, amount(), priority())
            .prop_map(|(from, to, amount, priority)| Call(Op::Submit(from, to, amount, priority))),
        2 => (0..BANKS, 0..BANKS, 1i128..=100, 0i128..=100, priority())
            .prop_map(|(from, to, over, under, priority)| Block(from, to, over, under, priority)),
        1 => prop_oneof![Just(1u64), Just(expiry + 1), 0u64..=2 * expiry].prop_map(|step| Call(Op::Tick(step))),
        2 => (id(), priority()).prop_map(|(id, priority)| Call(Op::Reprioritise(id, priority))),
        3 => any::<prop::sample::Index>().prop_map(MoveAimed),
        1 => (any::<prop::sample::Index>(), priority()).prop_map(|(pick, priority)| MoveQueued(pick, priority)),
        1 => any::<prop::sample::Index>().prop_map(RevokeQueued),
        1 => (any::<prop::sample::Index>(), priority()).prop_map(|(pick, priority)| MoveFinal(pick, priority)),
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

    /// Revocation takes out the revoked payment alone, then lets the closure settle what
    /// that releases, over any sequence of deposits, withdrawals, submissions, time steps
    /// and revocations, valid or not (A6; ADR-0016):
    /// - A6: an id never issued is refused with `UnknownPayment`, and a payment already
    ///   final, settled or revoked, with `NotQueued` (S3, S5). A refusal moves and records
    ///   nothing;
    /// - A6, S13 without the model's τ_rc cut-off (ADR-0016): any queued payment can be
    ///   revoked, even once A19's time steps take it past its ADR-0015 expiry. It becomes
    ///   `Revoked`, otherwise unchanged, and leaves its queue for good;
    /// - A6: a revocation moves no money of its own: each balance changes only by the
    ///   payments that settle in the call, and no payment is recorded;
    /// - A6, S3: every other payment queued before a call is unchanged, or settled with
    ///   every other field kept;
    /// - A2, S9, gross: between calls no bank's head in `≺` is covered, so the closure
    ///   settles whatever a revocation releases in the same call (ADR-0010);
    /// - S7 under F2: the queue views list each bank's queued payments in `≺` order, so the
    ///   others keep their order, and what settles in a call is, per bank, a `≺`-prefix of
    ///   its queue (ADR-0008, ADR-0009);
    /// - S3, S5: a final payment never changes, and `queued_count` counts the payments
    ///   queued, from their records;
    /// - A11, S1, S2: conservation, and no negative balance (ADR-0004, ADR-0011).
    ///
    /// Each bank starts with half its holding deposited, and `revocation_op` aims the calls
    /// at queues whose head a revocation releases. A refused deposit, withdrawal or
    /// submission is skipped. The calls need no later entry point, so this checks
    /// revocation before SC-P-01 can. Nothing is expired here, so `NotQueued` for an
    /// expired payment is left to SC-A06-05.
    #[test]
    fn revocation_takes_out_only_the_revoked_payment(ops in prop::collection::vec(revocation_op(), 1..30)) {
        let setup = Setup::new(BANKS, FUNDING);
        let client = setup.client();
        // Half of each holding, so that `Block` has a balance to queue a covered payment under.
        for bank in 0..BANKS {
            client.deposit(setup.bank(bank), &(FUNDING / 2));
        }
        let mut before = payments(&setup);
        let mut now = 0u64;

        for op in ops {
            let queues: Vec<Vec<u64>> = (0..BANKS).map(|bank| queued_in_order(&setup, &before, bank)).collect();
            let blocked: Vec<u64> = (0..BANKS)
                .filter(|&bank| {
                    let queue = &queues[bank];
                    queue.len() > 1 && before[&queue[1]].amount <= client.balance(setup.bank(bank))
                })
                .map(|bank| queues[bank][0])
                .collect();
            let heads: Vec<u64> = if blocked.is_empty() {
                queues.iter().filter_map(|queue| queue.first().copied()).collect()
            } else {
                blocked
            };
            let queued: Vec<u64> = queues.concat();
            let calls = match op {
                RevocationOp::Call(op) => vec![op],
                RevocationOp::Block(from, to, over, under, priority) => {
                    let balance = client.balance(setup.bank(from));
                    vec![
                        Op::Submit(from, to, balance + over, priority),
                        Op::Submit(from, to, balance - under, priority),
                    ]
                }
                RevocationOp::RevokeHead(pick) if !heads.is_empty() => vec![Op::Revoke(*pick.get(&heads))],
                RevocationOp::RevokeQueued(pick) if !queued.is_empty() => vec![Op::Revoke(*pick.get(&queued))],
                // Nothing is queued: an id one past the last is unknown.
                _ => vec![Op::Revoke(before.len() as u64)],
            };
            for op in calls {
                let balances = setup.balances();
                let mut revoked = None;
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
                    Op::Tick(step) => {
                        now += step;
                        setup.at(now);
                    }
                    Op::Revoke(id) => {
                        let result = typed(client.try_revoke(&id));
                        let after = payments(&setup);
                        match before.get(&id) {
                            None => prop_assert_eq!(result, Err(Error::UnknownPayment), "A6: unknown {}", id),
                            Some(payment) if is_final(payment.status) => {
                                prop_assert_eq!(result, Err(Error::NotQueued), "A6: final {}", id);
                            }
                            Some(payment) => {
                                prop_assert_eq!(result, Ok(()), "A6: queued {} refused", id);
                                let expected = Payment { status: Status::Revoked, ..payment.clone() };
                                prop_assert_eq!(after.get(&id), Some(&expected), "S13: {} revoked", id);
                                revoked = Some(id);
                            }
                        }
                        if result.is_err() {
                            prop_assert_eq!(&after, &before, "a refusal records nothing");
                        }
                        prop_assert_eq!(after.len(), before.len(), "A6 records no payment");
                        booked_only_settlements(&setup, &balances, &before, &after)?;
                    }
                    _ => unreachable!(),
                }

                setup.assert_conserved();
                let after = payments(&setup);
                queues_at_rest_in_order(&setup, &before, &after, revoked)?;
                before = after;
            }
        }
    }

    /// Reprioritisation changes the moved payment's priority alone, keeps its place by
    /// age, then lets the closure settle what that releases, over any sequence of
    /// deposits, withdrawals, submissions, time steps, revocations and reprioritisations,
    /// valid or not (A8 with `toEnd = false`; ADR-0009):
    /// - A8: an id never issued is refused with `UnknownPayment`, a payment already final,
    ///   settled or revoked, with `NotQueued` whatever the priority asked (S3, S5), and a
    ///   queued payment moved to its own priority with `SamePriority`, in the Quint spec's
    ///   order. A refusal moves and records nothing;
    /// - A8, A19: any other queued payment is moved, even past its expiry: as in the model,
    ///   A8 has no time guard, and a payment past its expiry stays queued until `expire`
    ///   (A5) runs (ADR-0015, as in `quint/settlement.qnt`); the model's A18 close, which
    ///   would have rejected it, is gone under ADR-0013. Only its priority changes, so it
    ///   keeps its id; it stays queued, or settles in the same call with every other field
    ///   kept;
    /// - A8: a reprioritisation moves no money of its own: each balance changes only by
    ///   the payments that settle in the call, and no payment is recorded;
    /// - A8, S3: every other payment queued before a call is unchanged, or settled with
    ///   every other field kept;
    /// - S7 under F2: the queue views list each bank's queued payments in `≺` order, so a
    ///   moved payment sits where its id sorts in its new priority, not at the end, and
    ///   what settles in a call is, per bank, a `≺`-prefix of its queue (ADR-0008,
    ///   ADR-0009);
    /// - A2, S9, gross: between calls no bank's head in `≺` is covered, so the closure
    ///   settles whatever a move releases in the same call (ADR-0010);
    /// - S3, S5: a final payment never changes, and `queued_count` counts the payments
    ///   queued, from their records;
    /// - A11, S1, S2: conservation, and no negative balance (ADR-0004, ADR-0011).
    ///
    /// Each bank starts with half its holding deposited, and `reprioritisation_op` aims
    /// the moves at payments whose move releases a queue. A refused deposit, withdrawal,
    /// submission or revocation is skipped. The calls need no later entry point, so this
    /// checks reprioritisation before SC-P-01 and SC-P-02 can. Nothing is expired here, so
    /// `NotQueued` for an expired payment is left to Flow 11.
    #[test]
    fn reprioritisation_moves_only_the_priority(ops in prop::collection::vec(reprioritisation_op(), 1..30)) {
        let setup = Setup::new(BANKS, FUNDING);
        let client = setup.client();
        // Half of each holding, so that `Block` has a balance to queue a covered payment under.
        for bank in 0..BANKS {
            client.deposit(setup.bank(bank), &(FUNDING / 2));
        }
        let mut before = payments(&setup);
        let mut now = 0u64;

        for op in ops {
            let queues: Vec<Vec<u64>> = (0..BANKS).map(|bank| queued_in_order(&setup, &before, bank)).collect();
            let queued: Vec<u64> = queues.concat();
            let other = |priority: Priority| match priority {
                Priority::Urgent => Priority::Normal,
                Priority::Normal => Priority::Urgent,
            };
            let unknown = before.len() as u64;
            let calls = match op {
                ReprioritisationOp::Call(op) => vec![op],
                ReprioritisationOp::Block(from, to, over, under, priority) => {
                    let balance = client.balance(setup.bank(from));
                    vec![
                        Op::Submit(from, to, balance + over, priority),
                        Op::Submit(from, to, balance - under, priority),
                    ]
                }
                ReprioritisationOp::MoveAimed(pick) if !queued.is_empty() => {
                    let aimed = releasing_moves(&setup, &before, &queues);
                    let pool = if aimed.is_empty() { &queued } else { &aimed };
                    let id = *pick.get(pool);
                    vec![Op::Reprioritise(id, other(before[&id].priority))]
                }
                ReprioritisationOp::MoveQueued(pick, priority) if !queued.is_empty() => {
                    vec![Op::Reprioritise(*pick.get(&queued), priority)]
                }
                ReprioritisationOp::RevokeQueued(pick) if !queued.is_empty() => vec![Op::Revoke(*pick.get(&queued))],
                ReprioritisationOp::MoveFinal(pick, priority) => {
                    let finals: Vec<u64> = before
                        .values()
                        .filter(|payment| is_final(payment.status))
                        .map(|payment| payment.id)
                        .collect();
                    let id = if finals.is_empty() { unknown } else { *pick.get(&finals) };
                    vec![Op::Reprioritise(id, priority)]
                }
                // Nothing is queued: an id one past the last is unknown.
                _ => vec![Op::Reprioritise(unknown, Priority::Urgent)],
            };
            for op in calls {
                let balances = setup.balances();
                let mut acted_on = None;
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
                    Op::Tick(step) => {
                        now += step;
                        setup.at(now);
                    }
                    Op::Revoke(id) => {
                        if typed(client.try_revoke(&id)).is_ok() {
                            acted_on = Some(id);
                        }
                    }
                    Op::Reprioritise(id, priority) => {
                        let result = typed(client.try_reprioritise(&id, &priority));
                        let after = payments(&setup);
                        match before.get(&id) {
                            None => prop_assert_eq!(result, Err(Error::UnknownPayment), "A8: unknown {}", id),
                            Some(payment) if is_final(payment.status) => {
                                prop_assert_eq!(result, Err(Error::NotQueued), "A8: final {}", id);
                            }
                            Some(payment) if payment.priority == priority => {
                                prop_assert_eq!(result, Err(Error::SamePriority), "A8: {} to its own priority", id);
                            }
                            Some(payment) => {
                                prop_assert_eq!(result, Ok(()), "A8: queued {} refused", id);
                                let moved = Payment { priority, ..payment.clone() };
                                let now = &after[&id];
                                let settled = Payment {
                                    status: Status::Settled,
                                    settled_at: now.settled_at,
                                    ..moved.clone()
                                };
                                prop_assert!(
                                    now == &moved || (now == &settled && now.settled_at.is_some()),
                                    "A8: {} moved to {:?}", id, now
                                );
                                acted_on = Some(id);
                            }
                        }
                        if result.is_err() {
                            prop_assert_eq!(&after, &before, "a refusal records nothing");
                        }
                        prop_assert_eq!(after.len(), before.len(), "A8 records no payment");
                        booked_only_settlements(&setup, &balances, &before, &after)?;
                    }
                    _ => unreachable!(),
                }

                setup.assert_conserved();
                let after = payments(&setup);
                queues_at_rest_in_order(&setup, &before, &after, acted_on)?;
                before = after;
            }
        }
    }
}
