//! The RTGS settlement contract: one contract holds the cash token and keeps every
//! bank's settlement balance (ADR-0004).
//!
//! Implemented so far: the constructor, `deposit`, `withdraw`, `submit` (which settles a
//! covered payment at once unless the sender has one queued ahead of it, and queues any
//! other up to the queue cap) and the `balance`, `payment`, `queue`, `queued_count`,
//! `config` and `central_bank` views. The other entry points are stubs whose unit tests
//! (`src/tests/`) are written and red; they are implemented test first (TESTING.md).
#![no_std]

#[cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    IntoVal, Val, Vec,
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
    /// Queuing the payment would exceed `Config::queue_cap` (ADR-0010).
    QueueFull = 5,
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
    /// The ids `bank` has queued at a priority, head first (ADR-0008, ADR-0009).
    Queue(Address, Priority),
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
/// overflow, since S1 bounds every balance by the tokens the contract holds.
fn settle(env: &Env, payment: &mut Payment, from_balance: i128) {
    set_balance(env, &payment.from, from_balance - payment.amount);
    let to_balance = Settlement::balance(env.clone(), payment.to.clone());
    set_balance(env, &payment.to, to_balance + payment.amount);
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
    queue.push_back(payment.id);
    put(
        env,
        &DataKey::Queue(payment.from.clone(), payment.priority),
        &queue,
    );
    let count = Settlement::queued_count(env.clone()) + 1;
    put(env, &DataKey::QueuedCount, &count);
}

/// S7 (ADR-0008, ADR-0009): whether `bank` has a payment queued ahead of a new one at
/// `priority`. An urgent payment queues behind the bank's urgent ones only; a normal one
/// behind every queued payment of the bank, since a queued urgent payment blocks its
/// normal ones.
fn queued_ahead(env: &Env, bank: &Address, priority: Priority) -> bool {
    let queued = |prio: Priority| !Settlement::queue(env.clone(), bank.clone(), prio).is_empty();
    queued(Priority::Urgent) || (priority == Priority::Normal && queued(Priority::Normal))
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
    /// `TokenTransferFailed`.
    pub fn deposit(env: Env, bank: Address, amount: i128) -> Result<(), Error> {
        bank.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        transfer(&env, &bank, &env.current_contract_address(), amount)?;
        let balance = Self::balance(env.clone(), bank.clone()) + amount;
        set_balance(&env, &bank, balance);
        Deposited { bank, amount }.publish(&env);
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
    /// waits at the tail of the sender's queue for its priority, unless `Config::queue_cap`
    /// payments are queued already: then it is refused with `QueueFull`, before an id is
    /// used (ADR-0010). The cap never refuses a payment that settles at once. Whether it
    /// refuses one that an offset would settle is still open (README): `quint/settlement.qnt`
    /// settles it, which would move this check after the closure (Flow 13).
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
        if !settles && Self::queued_count(env.clone()) >= Self::config(env.clone()).queue_cap {
            return Err(Error::QueueFull);
        }
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
        } else {
            enqueue(&env, &payment);
        }
        Ok(id)
    }

    /// A6: the sender revokes a queued payment (ADR-0016).
    pub fn revoke(_env: Env, _id: u64) -> Result<(), Error> {
        todo!()
    }

    /// A8: the sender moves a queued payment to the other priority, keeping its place.
    pub fn reprioritise(_env: Env, _id: u64, _priority: Priority) -> Result<(), Error> {
        todo!()
    }

    /// A5: anyone rejects a queued payment whose expiry has passed (ADR-0015).
    pub fn expire(_env: Env, _id: u64) -> Result<(), Error> {
        todo!()
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
