//! The RTGS settlement contract: one contract holds the cash token and keeps every
//! bank's settlement balance (ADR-0004).
//!
//! Implemented so far: the constructor, `deposit`, `withdraw`, `submit` (which settles a
//! covered payment at once unless the sender has one queued ahead of it, queues any
//! other, and refuses one still queued after the eager closure when the queue was already
//! full), `revoke`, `reprioritise`, `expire`, the eager closure (gross settlement, then the
//! LSM offset) after every deposit, submission, revocation, reprioritisation or expiry,
//! and the `balance`, `payment`, `queue`, `queued_count`, `config` and `central_bank`
//! views. The other entry points are stubs whose unit tests (`src/tests/`) are written and
//! red; they are implemented test first (TESTING.md).
#![no_std]

extern crate alloc;
#[cfg(test)]
extern crate std;

use alloc::vec::Vec as AVec;
use rtgs_core::Candidate;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    IntoVal, Map, Val, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
/// Every entry point extends each entry it writes to about 30 days (handbook 06: extend
/// every entry).
const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_THRESHOLD: u32 = BUMP_AMOUNT - DAY_IN_LEDGERS;

/// The contract's settings. Each provisional decision is one field, so ratification can
/// change it without touching the code that uses it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// The most payments that may be queued at once, across all banks. Spec O ranges over
    /// every queued payment, so the queue is capped to what one transaction can settle
    /// (ADR-0010).
    pub queue_cap: u32,
    /// Seconds after submission after which a queued payment may be rejected (ADR-0015).
    pub expiry_secs: u64,
    /// Seconds after it opens after which an unpaid repo becomes a penalty repo (ADR-0014).
    pub repo_term_secs: u64,
    /// The rate recorded on a penalty repo, in basis points (ADR-0014).
    pub penalty_rate_bps: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// An amount or value that must be positive (or, for collateral, non-negative) is not.
    InvalidAmount = 1,
    /// The cash token refused a transfer into or out of the contract.
    TokenTransferFailed = 2,
    /// The bank's settlement balance is below the amount.
    InsufficientFunds = 3,
    /// A payment's sender and receiver are the same bank (§4.6 A1).
    SameAccount = 4,
    /// The payment would still be queued after the eager closure, with more than
    /// `Config::queue_cap` queued (ADR-0010).
    QueueFull = 5,
    /// No payment has this id (A5, A6, A8).
    UnknownPayment = 6,
    /// The payment is final: settled, revoked or expired (S3, S5).
    NotQueued = 7,
    /// A reprioritisation to the priority the payment already has.
    SamePriority = 8,
    /// The payment's expiry has not passed yet (ADR-0015).
    NotExpired = 9,
    /// The actor may not take this action (S6).
    NotAuthorized = 10,
    /// The collateral would fall below the credit it backs (A14, S21).
    CollateralBelowCredit = 11,
    /// The credit would exceed the collateral (A12, S17, S21).
    CreditExceedsCollateral = 12,
    UnknownRepo = 13,
    /// The repayment is more than the repo's outstanding amount (A13, A20).
    RepayExceedsRepo = 14,
    /// The repo's term has not passed, or it is repaid (ADR-0014).
    NotOverdue = 15,
    /// The repo is already a penalty repo (ADR-0014).
    AlreadyPenalty = 16,
}

/// Two priorities, each queued first in, first out (ADR-0008, ADR-0009).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Priority {
    Normal,
    Urgent,
}

/// The priorities in `≺` order: a bank's urgent payments go before its normal ones (S7,
/// ADR-0009).
const PRIORITIES: [Priority; 2] = [Priority::Urgent, Priority::Normal];

/// A payment's status (§4.3 `st`). `Expired` is the model's `rejected` (A5, ADR-0015).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Queued,
    Settled,
    Revoked,
    Expired,
}

/// A payment order (§4.3). Its id is its sequence number `q`: reprioritising keeps a
/// payment's place, so the sequence number never changes (A8 with toEnd = false).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payment {
    pub id: u64,
    pub from: Address,
    pub to: Address,
    pub amount: i128,
    pub priority: Priority,
    /// Ledger time of submission, from which the expiry runs (ADR-0015).
    pub submitted_at: u64,
    pub status: Status,
    /// Ledger time of settlement (§4.3 `t_set`).
    pub settled_at: Option<u64>,
}

/// A bank's credit position (§4.4 `cr`, `ovn`, `coll`). `ovn` holds penalty repos, which
/// replace overnight credit (ADR-0014).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Credit {
    pub cr: i128,
    pub ovn: i128,
    pub coll: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStatus {
    Intraday,
    Penalty,
    Repaid,
}

/// One intraday repo (ADR-0011, ADR-0014).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Repo {
    pub id: u64,
    pub bank: Address,
    pub amount: i128,
    pub outstanding: i128,
    pub opened_at: u64,
    pub status: RepoStatus,
    /// The penalty rate, recorded when the repo becomes a penalty repo; 0 before.
    pub rate_bps: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Token,
    CentralBank,
    Config,
    /// One key per bank, so payments between different banks don't share a hot key
    /// (handbook 09 §3).
    Balance(Address),
    /// The id the next submitted payment gets (S11). The counters are persistent, not in
    /// the instance, so a submission doesn't write the entry every call reads (handbook 09
    /// §3).
    NextId,
    /// How many payments are queued, across all banks.
    QueuedCount,
    Payment(u64),
    /// The ids `bank` has queued at a priority, head first and so in id order (ADR-0008,
    /// ADR-0009); no entry while the queue is empty.
    Queue(Address, Priority),
    /// The banks with a `Queue` entry at a priority, each once and in no set order, for the
    /// offset, which ranges over every queue (Spec O) and through this index reads only the
    /// queues that exist, as gross settlement does; no entry while no payment is queued at
    /// that priority.
    QueuedBanks(Priority),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub bank: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub bank: Address,
    pub amount: i128,
}

/// A1: the payment entered the system.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Submitted {
    #[topic]
    pub id: u64,
    pub from: Address,
    pub to: Address,
    pub amount: i128,
    pub priority: Priority,
}

/// A2, or one payment of an A3: the payment is final (ADR-0005).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub id: u64,
    pub from: Address,
    pub to: Address,
    pub amount: i128,
}

/// A3: an offset of the greatest feasible prefix, its payments in id order. Each one's
/// `Settled` event follows.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Offset {
    pub ids: Vec<u64>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Revoked {
    #[topic]
    pub id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reprioritised {
    #[topic]
    pub id: u64,
    pub priority: Priority,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Expired {
    #[topic]
    pub id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralSet {
    #[topic]
    pub bank: Address,
    pub value: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoOpened {
    #[topic]
    pub id: u64,
    pub bank: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoRepaid {
    #[topic]
    pub id: u64,
    pub amount: i128,
    pub outstanding: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoPenalised {
    #[topic]
    pub id: u64,
    pub rate_bps: u32,
}

/// Moves `amount` of the cash token from `from` to `to` through its SAC (ADR-0003), and
/// extends the instance that records the token. Whatever the SAC refuses is reported as
/// `TokenTransferFailed`.
fn transfer(env: &Env, from: &Address, to: &Address, amount: i128) -> Result<(), Error> {
    let instance = env.storage().instance();
    instance.extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);

    let token: Address = instance.get(&DataKey::Token).unwrap();
    match token::Client::new(env, &token).try_transfer(from, to, &amount) {
        Ok(Ok(())) => Ok(()),
        _ => Err(Error::TokenTransferFailed),
    }
}

/// Writes a persistent entry and extends it.
fn put<V: IntoVal<Env, Val>>(env: &Env, key: &DataKey, value: &V) {
    let persistent = env.storage().persistent();
    persistent.set(key, value);
    persistent.extend_ttl(key, BUMP_THRESHOLD, BUMP_AMOUNT);
}

/// Records the bank's settlement balance and extends its entry.
fn set_balance(env: &Env, bank: &Address, balance: i128) {
    put(env, &DataKey::Balance(bank.clone()), &balance);
}

/// A2: moves the payment's amount from its sender's balance, `from_balance`, to its
/// receiver's, and records it settled at the ledger's close time. The caller has checked
/// that `from_balance` covers it. No token moves (S1), and the receiver's sum cannot
/// overflow, since S1 bounds every balance by the tokens the contract holds. Returns the
/// sender's balance after the payment.
fn settle(env: &Env, payment: &mut Payment, from_balance: i128) -> i128 {
    let remaining_from_balance = from_balance - payment.amount;
    set_balance(env, &payment.from, remaining_from_balance);
    let to_balance = Settlement::balance(env.clone(), payment.to.clone());
    set_balance(env, &payment.to, to_balance + payment.amount);
    record_settled(env, payment);
    remaining_from_balance
}

/// Records the payment settled at the ledger's close time and publishes its `Settled`
/// event. The balances are the caller's to move.
fn record_settled(env: &Env, payment: &mut Payment) {
    payment.status = Status::Settled;
    payment.settled_at = Some(env.ledger().timestamp());
    put(env, &DataKey::Payment(payment.id), payment);
    Settled {
        id: payment.id,
        from: payment.from.clone(),
        to: payment.to.clone(),
        amount: payment.amount,
    }
    .publish(env);
}

/// Records the queued payment and puts it at the tail of its sender's queue for its
/// priority.
fn enqueue(env: &Env, payment: &Payment) {
    put(env, &DataKey::Payment(payment.id), payment);
    let mut queue = Settlement::queue(env.clone(), payment.from.clone(), payment.priority);
    let was_empty = queue.is_empty();
    queue.push_back(payment.id);
    put_queue(env, &payment.from, payment.priority, &queue, was_empty);
    let count = Settlement::queued_count(env.clone()) + 1;
    put(env, &DataKey::QueuedCount, &count);
}

/// `remove_from_queue`, and one fewer in `QueuedCount`.
fn dequeue(env: &Env, payment: &Payment) {
    remove_from_queue(env, payment);
    let count = Settlement::queued_count(env.clone()) - 1;
    put(env, &DataKey::QueuedCount, &count);
}

/// Takes the queued payment out of its sender's queue for its priority, wherever it
/// stands, keeping the others in order. A queued payment is always in that queue.
fn remove_from_queue(env: &Env, payment: &Payment) {
    let mut queue = Settlement::queue(env.clone(), payment.from.clone(), payment.priority);
    let i = queue.first_index_of(payment.id).unwrap();
    queue.remove(i);
    put_queue(env, &payment.from, payment.priority, &queue, false);
}

/// Puts the queued payment into its sender's queue for its priority at its place by age.
/// Ids are sequence numbers (S11) and every queue is kept in id order, so its place is
/// where its id sorts (A8 with `toEnd = false`, decided with the user on 2026-10-24). The
/// payment is in no queue of its sender's yet.
fn insert_by_age(env: &Env, payment: &Payment) {
    let mut queue = Settlement::queue(env.clone(), payment.from.clone(), payment.priority);
    let was_empty = queue.is_empty();
    let i = queue.binary_search(payment.id).unwrap_err();
    queue.insert(i, payment.id);
    put_queue(env, &payment.from, payment.priority, &queue, was_empty);
}

/// The eager closure (§4.6, S9, S23; ADR-0010): gross settlement from `banks`, then, at
/// rest, the offset of the greatest feasible prefix. All of it runs in the calling
/// transaction.
///
/// The model's closure (quint/settlement.qnt) repeats both until an offset settles
/// nothing. Since k* decides F1 exactly, R5 makes every round after the first offset
/// empty, so the contract runs one. A head covered after k*, with every candidate ahead
/// of it in k*, would extend k* to a greater feasible prefix, and so would any further
/// feasible offset. So the closure ends at rest (S9, S23), as SC-P-12 to SC-P-15 check
/// after every call, without reading every queue a second time.
///
/// R5 rests on three things this argument assumes: both priorities are strict FIFO
/// (ADR-0008, ADR-0009), `covers` and F1 use one floor (today 0, since credit is minted
/// into the balance, ADR-0011), and there are no limits or reservations, so K6 holds
/// (ADR-0018, provisional). A credit line would not change this, so long as both used it.
/// Limits, or a class that bypasses FIFO, would let a prefix that fails as a whole settle
/// in parts (C-DF-026), and the model's loop would have to come back.
fn eager_closure(env: &Env, banks: Vec<Address>) {
    settle_gross(env, banks);
    offset(env);
}

/// A2 in the eager closure (§4.6, S9; ADR-0010): settles every covered head of `banks`,
/// urgent first (S7, ADR-0009), and follows the cascade through the queues of each bank a
/// settlement credits.
///
/// The queues were at rest before the call, so `banks` must hold every bank whose balance
/// rose or whose queue head changed since: only those can have a covered head. A
/// settlement raises its receiver's balance, so the receiver joins `banks` unless it is
/// already waiting there. Under FIFO the order the banks are visited in does not change
/// what settles (R2). A bank joins only at the start or after a settlement, and each
/// settlement takes one of the queued payments, which the cap bounds, so the visits are at most
/// `banks.len()` plus the settlements: gross settlement ends, and it ends with no head
/// covered.
///
/// It reads a bank's queue at a priority only if the bank is in that priority's
/// `QueuedBanks` index, read once at the start: gross settlement only shortens queues, so
/// no bank joins an index during it. A cascade through a full queue then reads no queue
/// that did not exist when it began, and fits Mainnet's footprint (SC-ST-05, SC-ST-07).
/// A queue it empties may be read again if the cascade comes back to its bank, at no
/// footprint cost: the entry is already in the footprint, as a write.
fn settle_gross(env: &Env, mut banks: Vec<Address>) {
    let mut settled = 0;
    let indexed = PRIORITIES.map(|priority| queued_banks(env, priority));
    while let Some(bank) = banks.pop_front() {
        let mut balance = Settlement::balance(env.clone(), bank.clone());
        for (rank, priority) in PRIORITIES.into_iter().enumerate() {
            if !indexed[rank].contains(&bank) {
                continue;
            }
            let mut queue = Settlement::queue(env.clone(), bank.clone(), priority);
            let queue_len = queue.len();
            while let Some(id) = queue.first() {
                let mut payment = Settlement::payment(env.clone(), id).unwrap();
                if !rtgs_core::covers(balance, payment.amount) {
                    break;
                }
                queue.pop_front();
                balance = settle(env, &mut payment, balance);
                // The receiver was just credited, so its head may now be covered: it
                // joins the worklist.
                if !banks.contains(&payment.to) {
                    banks.push_back(payment.to);
                }
            }
            if queue.len() < queue_len {
                settled += queue_len - queue.len();
                put_queue(env, &bank, priority, &queue, false);
            }
            // The head left queued is not covered. If it is urgent, it blocks the bank's
            // normal payments (S7).
            if !queue.is_empty() {
                break;
            }
        }
    }
    if settled > 0 {
        let count = Settlement::queued_count(env.clone()) - settled;
        put(env, &DataKey::QueuedCount, &count);
    }
}

/// A3 `Offset` under Spec O with F2, one phase (ADR-0010): settles the greatest feasible
/// prefix k* of every queued bank's candidates (R4), as one `Offset` event and then one
/// `Settled` event per payment, all in id order. When k* is zero it settles nothing and
/// publishes nothing.
///
/// A bank's candidates are its queued payments in `≺` order: urgent first, then by id
/// (§4.5, ADR-0009). So the offset never takes a payment ahead of an older one of the
/// same priority (F2, F6), nor a normal one without every urgent one of its bank (S7). The
/// accounts are the queued banks and the banks they pay; one that only receives has no
/// candidates and cannot break F1, but is credited (SC-A03-20).
///
/// Each bank's net change is booked exactly (`rtgs_core::balances_after`): queued sums
/// can exceed `i128` (SC-A03-11, SC-A03-12), but F1 and S1 put every final balance
/// between 0 and the tokens the contract holds. A bank whose balance nets to what it was
/// is not rewritten, and each `QueuedBanks` index is written at most once, when one of
/// its queues emptied.
///
/// It reads only the queues that exist, through the two indexes, so that the offset over
/// a full queue fits Mainnet's footprint (SC-ST-04, SC-ST-06).
fn offset(env: &Env) {
    let mut index: Map<Address, u32> = Map::new(env);
    let mut accounts: AVec<Address> = AVec::new();
    let mut account = |bank: &Address| match index.get(bank.clone()) {
        Some(account) => account as usize,
        None => {
            index.set(bank.clone(), accounts.len() as u32);
            accounts.push(bank.clone());
            accounts.len() - 1
        }
    };
    // `queues[slot]` and `payments[slot]` belong to a queued bank, the first accounts, with
    // its queues in `PRIORITIES` order, empty where it has none.
    let mut indexed = [0; 2];
    let mut queues: AVec<(Address, [Vec<u64>; 2])> = AVec::new();
    for (rank, priority) in PRIORITIES.into_iter().enumerate() {
        let banks = queued_banks(env, priority);
        indexed[rank] = banks.len();
        for bank in banks.iter() {
            let slot = account(&bank);
            if slot == queues.len() {
                queues.push((bank.clone(), [Vec::new(env), Vec::new(env)]));
            }
            // Each index holds a bank once; SC-P-12 to SC-P-15 check that `put_queue`
            // keeps it so. Were a bank there twice, the tests stop here, and a release
            // build reads its queue once, not twice.
            let unread = queues[slot].1[rank].is_empty();
            debug_assert!(unread, "a QueuedBanks index holds a bank twice");
            if unread {
                queues[slot].1[rank] = Settlement::queue(env.clone(), bank, priority);
            }
        }
    }
    let payments: AVec<AVec<Payment>> = queues
        .iter()
        .map(|(_, [urgent, normal])| {
            urgent
                .iter()
                .chain(normal.iter())
                .map(|id| Settlement::payment(env.clone(), id).unwrap())
                .collect()
        })
        .collect();
    let mut candidates: AVec<AVec<Candidate>> = payments
        .iter()
        .map(|bank_payments| {
            bank_payments
                .iter()
                .map(|payment| Candidate {
                    to: account(&payment.to),
                    amount: payment.amount,
                })
                .collect()
        })
        .collect();
    candidates.resize(accounts.len(), AVec::new());
    let before: AVec<i128> = accounts
        .iter()
        .map(|bank| Settlement::balance(env.clone(), bank.clone()))
        .collect();

    let prefix = rtgs_core::greatest_feasible_prefix(&before, &candidates);
    let settled: u32 = prefix.iter().map(|&taken| taken as u32).sum();
    if settled == 0 {
        return;
    }

    let after = rtgs_core::balances_after(&before, &candidates, &prefix);
    for (account, bank) in accounts.iter().enumerate() {
        if after[account] != before[account] {
            set_balance(env, bank, after[account]);
        }
    }
    let mut still_queued = [Vec::new(env), Vec::new(env)];
    for ((bank, by_priority), &taken_from_bank) in queues.into_iter().zip(&prefix) {
        let mut left = taken_from_bank as u32;
        for (rank, priority) in PRIORITIES.into_iter().enumerate() {
            let queue = &by_priority[rank];
            let taken = left.min(queue.len());
            if taken > 0 {
                write_queue(env, &bank, priority, &queue.slice(taken..));
                left -= taken;
            }
            if queue.len() > taken {
                still_queued[rank].push_back(bank.clone());
            }
        }
    }
    for (rank, priority) in PRIORITIES.into_iter().enumerate() {
        if still_queued[rank].len() < indexed[rank] {
            put_queued_banks(env, priority, &still_queued[rank]);
        }
    }
    let count = Settlement::queued_count(env.clone()) - settled;
    put(env, &DataKey::QueuedCount, &count);

    let mut offset: AVec<Payment> = payments
        .into_iter()
        .zip(&prefix)
        .flat_map(|(bank_payments, &taken)| bank_payments.into_iter().take(taken))
        .collect();
    offset.sort_unstable_by_key(|payment| payment.id);
    Offset {
        ids: Vec::from_iter(env, offset.iter().map(|payment| payment.id)),
    }
    .publish(env);
    for payment in &mut offset {
        record_settled(env, payment);
    }
}

/// The banks with a payment queued at `priority`, in no set order.
fn queued_banks(env: &Env, priority: Priority) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::QueuedBanks(priority))
        .unwrap_or_else(|| Vec::new(env))
}

/// Records the banks with a payment queued at `priority`, or removes the entry once there
/// are none.
fn put_queued_banks(env: &Env, priority: Priority, banks: &Vec<Address>) {
    let key = DataKey::QueuedBanks(priority);
    if banks.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        put(env, &key, banks);
    }
}

/// `write_queue`, keeping `QueuedBanks(priority)`: the bank joins it when its queue gets a
/// first payment, and leaves it when the queue loses its last. The caller says whether the
/// queue was empty before, which it has read, so no other entry is read to know it.
fn put_queue(env: &Env, bank: &Address, priority: Priority, queue: &Vec<u64>, was_empty: bool) {
    write_queue(env, bank, priority, queue);
    if was_empty == queue.is_empty() {
        return;
    }
    let mut banks = queued_banks(env, priority);
    if was_empty {
        banks.push_back(bank.clone());
    } else {
        banks.remove(banks.first_index_of(bank).unwrap());
    }
    put_queued_banks(env, priority, &banks);
}

/// Records `bank`'s queue at `priority`, or removes its entry once the queue is empty. It
/// leaves `QueuedBanks` to the caller.
fn write_queue(env: &Env, bank: &Address, priority: Priority, queue: &Vec<u64>) {
    let key = DataKey::Queue(bank.clone(), priority);
    if queue.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        put(env, &key, queue);
    }
}

/// S7 (ADR-0008, ADR-0009): whether `bank` has a payment queued ahead of a new one at
/// `priority`. An urgent payment queues behind the bank's urgent ones only; a normal one
/// behind every queued payment of the bank, since a queued urgent payment blocks its
/// normal ones.
fn queued_ahead(env: &Env, bank: &Address, priority: Priority) -> bool {
    let queued = |prio: Priority| !Settlement::queue(env.clone(), bank.clone(), prio).is_empty();
    queued(Priority::Urgent) || (priority == Priority::Normal && queued(Priority::Normal))
}

/// ADR-0010's queue cap, after the eager closure: whether the payment `id` just submitted
/// is still queued and more than `Config::queue_cap` payments are queued. Only a payment
/// that stays queued can be refused, so one that settles at once, gross or in an offset,
/// never is (the model's rule, decided with the user on 2026-10-25). The closure settles
/// nothing without the new payment, since the queues were at rest before it: so a payment
/// still queued settled nothing, and the cap is exceeded exactly when it was already full.
/// The status check is then implied by the count, and is kept to mirror the model's guard
/// (`quint/settlement.qnt`, `submit`).
fn over_the_cap(env: &Env, id: u64) -> bool {
    Settlement::payment(env.clone(), id).unwrap().status == Status::Queued
        && Settlement::queued_count(env.clone()) > Settlement::config(env.clone()).queue_cap
}

#[contract]
pub struct Settlement;

#[contractimpl]
impl Settlement {
    /// `token` is the cash token's Stellar Asset Contract (ADR-0003), and `cb` the central
    /// bank: the token's issuer and the authority for credit (ADR-0011).
    pub fn __constructor(env: Env, token: Address, cb: Address, config: Config) {
        // Not extended here: a new instance starts at the network's minimum persistent TTL
        // (C-SC-045), and every entry point that writes extends it.
        let instance = env.storage().instance();
        instance.set(&DataKey::Token, &token);
        instance.set(&DataKey::CentralBank, &cb);
        instance.set(&DataKey::Config, &config);
    }

    /// Moves `amount` of the cash token from `bank` into this contract and credits the
    /// bank's settlement balance. An amount of 0 or less is refused with `InvalidAmount`
    /// before the SAC is called. Whatever the SAC refuses (too low a holding, a holder not
    /// authorized, an overflow, a transfer the bank did not authorize) is reported as
    /// `TokenTransferFailed`. Then the eager closure settles whatever the deposit covers
    /// or makes feasible to offset, after `Deposited` (S9, S23).
    pub fn deposit(env: Env, bank: Address, amount: i128) -> Result<(), Error> {
        bank.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        transfer(&env, &bank, &env.current_contract_address(), amount)?;
        let balance = Self::balance(env.clone(), bank.clone()) + amount;
        set_balance(&env, &bank, balance);
        Deposited {
            bank: bank.clone(),
            amount,
        }
        .publish(&env);
        eager_closure(&env, Vec::from_array(&env, [bank]));
        Ok(())
    }

    /// Debits the bank's settlement balance and pays `amount` out in the cash token. An
    /// amount of 0 or less is refused with `InvalidAmount`, and one above the balance with
    /// `InsufficientFunds`, before the SAC is called. A transfer the SAC refuses (a bank
    /// not authorized to hold the token) is reported as `TokenTransferFailed`, and the
    /// debit is rolled back with it.
    pub fn withdraw(env: Env, bank: Address, amount: i128) -> Result<(), Error> {
        bank.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let balance = Self::balance(env.clone(), bank.clone());
        if balance < amount {
            return Err(Error::InsufficientFunds);
        }
        set_balance(&env, &bank, balance - amount);
        transfer(&env, &env.current_contract_address(), &bank, amount)?;
        Withdrawn { bank, amount }.publish(&env);
        Ok(())
    }

    /// A1: submits a payment and returns its id, then settles eagerly (A2, A3).
    ///
    /// The sender authorizes it alone (S6). An amount of 0 or less is refused with
    /// `InvalidAmount`, and a payment to oneself with `SameAccount`, before an id is used.
    /// The id is the next sequence number (S11). A covered payment settles at once (A2) if
    /// nothing of the sender's is queued ahead of it (S7, ADR-0008, ADR-0009); any other
    /// waits at the tail of the sender's queue for its priority. A payment that settles at
    /// once credits its receiver, so the eager closure follows it (S9). One that queues may
    /// complete an offset, so the closure follows it too (A3, S23). If the payment is still
    /// queued after the closure and more than `Config::queue_cap` payments are queued, it
    /// is refused with `QueueFull`, and the refusal rolls back the whole call, its id
    /// included (ADR-0010). So the cap never refuses a payment that settles at once, gross
    /// or in an offset, as in the model (decided with the user on 2026-10-25).
    pub fn submit(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
        priority: Priority,
    ) -> Result<u64, Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if from == to {
            return Err(Error::SameAccount);
        }
        let balance = Self::balance(env.clone(), from.clone());
        let settles = !queued_ahead(&env, &from, priority) && rtgs_core::covers(balance, amount);
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
        let id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::NextId)
            .unwrap_or(0);
        put(&env, &DataKey::NextId, &(id + 1));
        let mut payment = Payment {
            id,
            from,
            to,
            amount,
            priority,
            submitted_at: env.ledger().timestamp(),
            status: Status::Queued,
            settled_at: None,
        };
        Submitted {
            id,
            from: payment.from.clone(),
            to: payment.to.clone(),
            amount,
            priority,
        }
        .publish(&env);
        if settles {
            settle(&env, &mut payment, balance);
            eager_closure(&env, Vec::from_array(&env, [payment.to]));
        } else {
            enqueue(&env, &payment);
            // No head is newly covered, but the payment may complete an offset (SC-A03-01).
            eager_closure(&env, Vec::new(&env));
            if over_the_cap(&env, id) {
                return Err(Error::QueueFull);
            }
        }
        Ok(id)
    }

    /// A6: the sender revokes a queued payment (ADR-0016), then settles eagerly.
    ///
    /// An id never issued is refused with `UnknownPayment`. The sender authorizes it alone
    /// (S6); the receiver's consent is neither needed nor enough. Revocation has no
    /// cut-off: a payment is revocable until it is final (ADR-0016), and a settled, revoked
    /// or expired one is refused with `NotQueued` (S3, S5). The payment leaves its queue
    /// for good with status `Revoked` (S13). Its sender's queue head may change, so the
    /// eager closure follows (S9, ADR-0010).
    pub fn revoke(env: Env, id: u64) -> Result<(), Error> {
        let mut payment = Self::payment(env.clone(), id).ok_or(Error::UnknownPayment)?;
        payment.from.require_auth();
        if payment.status != Status::Queued {
            return Err(Error::NotQueued);
        }
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
        dequeue(&env, &payment);
        payment.status = Status::Revoked;
        put(&env, &DataKey::Payment(id), &payment);
        Revoked { id }.publish(&env);
        eager_closure(&env, Vec::from_array(&env, [payment.from]));
        Ok(())
    }

    /// A8 with `toEnd = false`: the sender moves a queued payment to the other priority
    /// (ADR-0009), keeping its place by age (decided with the user on 2026-10-24), then
    /// settles eagerly.
    ///
    /// An id never issued is refused with `UnknownPayment`. The sender authorizes it alone
    /// (S6). A payment no longer queued is refused with `NotQueued` (S3, S5), and a move to
    /// the priority it already has with `SamePriority`. The payment keeps its id, so it
    /// goes into the other queue where its id sorts, not at the end. Both of its sender's
    /// queue heads may change, so the eager closure follows (S7, S9, ADR-0010).
    pub fn reprioritise(env: Env, id: u64, priority: Priority) -> Result<(), Error> {
        let mut payment = Self::payment(env.clone(), id).ok_or(Error::UnknownPayment)?;
        payment.from.require_auth();
        if payment.status != Status::Queued {
            return Err(Error::NotQueued);
        }
        if payment.priority == priority {
            return Err(Error::SamePriority);
        }
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
        remove_from_queue(&env, &payment);
        payment.priority = priority;
        insert_by_age(&env, &payment);
        put(&env, &DataKey::Payment(id), &payment);
        Reprioritised { id, priority }.publish(&env);
        eager_closure(&env, Vec::from_array(&env, [payment.from]));
        Ok(())
    }

    /// A5: anyone rejects a queued payment whose expiry has passed (ADR-0015), then
    /// settles eagerly.
    ///
    /// Rejection is the system's step, so it needs no authorization (S6, M1): any keeper
    /// may call it. An id never issued is refused with `UnknownPayment`, and a payment no
    /// longer queued with `NotQueued` (S3, S5). While `now <= submitted_at + expiry_secs`
    /// it is refused with `NotExpired`; the strict comparison stays correct when two
    /// ledgers share a timestamp (handbook 09 §3). The payment leaves its queue for good
    /// with status `Expired`. Its sender's queue head may change, so the eager closure
    /// follows (S9, ADR-0010). Until someone expires it, a payment past its expiry stays
    /// queued and can still settle; whether it should is still open (README).
    pub fn expire(env: Env, id: u64) -> Result<(), Error> {
        let mut payment = Self::payment(env.clone(), id).ok_or(Error::UnknownPayment)?;
        if payment.status != Status::Queued {
            return Err(Error::NotQueued);
        }
        let expiry = Self::config(env.clone()).expiry_secs;
        if env.ledger().timestamp() <= payment.submitted_at.saturating_add(expiry) {
            return Err(Error::NotExpired);
        }
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
        dequeue(&env, &payment);
        payment.status = Status::Expired;
        put(&env, &DataKey::Payment(id), &payment);
        Expired { id }.publish(&env);
        eager_closure(&env, Vec::from_array(&env, [payment.from]));
        Ok(())
    }

    /// A14: the central bank sets a bank's collateral value, after haircuts.
    pub fn set_collateral(_env: Env, _bank: Address, _value: i128) -> Result<(), Error> {
        todo!()
    }

    /// A12: the central bank opens a repo, minting `amount` against the bank's collateral.
    pub fn open_repo(_env: Env, _bank: Address, _amount: i128) -> Result<u64, Error> {
        todo!()
    }

    /// A13, or A20 for a penalty repo: the bank or the central bank repays, burning cash.
    pub fn repay(_env: Env, _actor: Address, _repo_id: u64, _amount: i128) -> Result<(), Error> {
        todo!()
    }

    /// ADR-0014: anyone turns a repo past its term into a penalty repo.
    pub fn convert_overdue(_env: Env, _repo_id: u64) -> Result<(), Error> {
        todo!()
    }

    /// The bank's settlement balance; 0 for a bank that never deposited.
    pub fn balance(env: Env, bank: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(bank))
            .unwrap_or(0)
    }

    pub fn payment(env: Env, id: u64) -> Option<Payment> {
        env.storage().persistent().get(&DataKey::Payment(id))
    }

    /// The ids queued by `bank` at `priority`, head first.
    pub fn queue(env: Env, bank: Address, priority: Priority) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::Queue(bank, priority))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// How many payments are queued, across all banks.
    pub fn queued_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::QueuedCount)
            .unwrap_or(0)
    }

    /// The bank's credit position; all zero for a bank with none.
    pub fn credit(_env: Env, _bank: Address) -> Credit {
        todo!()
    }

    pub fn repo(_env: Env, _id: u64) -> Option<Repo> {
        todo!()
    }

    pub fn config(env: Env) -> Config {
        env.storage().instance().get(&DataKey::Config).unwrap()
    }

    pub fn central_bank(env: Env) -> Address {
        env.storage().instance().get(&DataKey::CentralBank).unwrap()
    }
}

#[cfg(test)]
mod tests;
