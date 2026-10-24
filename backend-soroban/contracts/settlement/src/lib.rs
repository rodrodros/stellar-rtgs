//! The RTGS settlement contract: one contract holds the cash token and keeps every
//! bank's settlement balance (ADR-0004).
//!
//! Only the constructor, `deposit`, `withdraw` and the `balance`, `config` and
//! `central_bank` views are implemented. The other entry points are stubs whose unit
//! tests (`src/tests/`) are written and red; they are implemented test first (TESTING.md).
#![no_std]

#[cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Vec,
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

/// Records the bank's settlement balance and extends its entry.
fn set_balance(env: &Env, bank: &Address, balance: i128) {
    let key = DataKey::Balance(bank.clone());
    let persistent = env.storage().persistent();
    persistent.set(&key, &balance);
    persistent.extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
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
    pub fn submit(
        _env: Env,
        _from: Address,
        _to: Address,
        _amount: i128,
        _priority: Priority,
    ) -> Result<u64, Error> {
        todo!()
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

    pub fn payment(_env: Env, _id: u64) -> Option<Payment> {
        todo!()
    }

    /// The ids queued by `bank` at `priority`, head first.
    pub fn queue(_env: Env, _bank: Address, _priority: Priority) -> Vec<u64> {
        todo!()
    }

    /// How many payments are queued, across all banks.
    pub fn queued_count(_env: Env) -> u32 {
        todo!()
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
