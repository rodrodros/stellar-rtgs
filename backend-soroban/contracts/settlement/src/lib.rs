//! The RTGS settlement contract: one contract holds the cash token and keeps every
//! bank's settlement balance (ADR-0004).
//!
//! So far it has only deposits. Payments, queues, offsetting and credit come in later
//! tasks, test first (TESTING.md).
#![no_std]

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, token, Address, Env};

const DAY_IN_LEDGERS: u32 = 17_280;
/// Every write extends the entry's TTL to about 30 days (handbook 06: extend every entry).
const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_THRESHOLD: u32 = BUMP_AMOUNT - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Token,
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

#[contract]
pub struct Settlement;

#[contractimpl]
impl Settlement {
    /// `token` is the cash token's Stellar Asset Contract (ADR-0003).
    pub fn __constructor(env: Env, token: Address) {
        env.storage().instance().set(&DataKey::Token, &token);
    }

    /// Moves `amount` of the cash token from `bank` into this contract and credits the
    /// bank's settlement balance.
    pub fn deposit(env: Env, bank: Address, amount: i128) {
        bank.require_auth();
        let instance = env.storage().instance();
        instance.extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
        let token: Address = instance.get(&DataKey::Token).unwrap();
        token::Client::new(&env, &token).transfer(&bank, env.current_contract_address(), &amount);
        let key = DataKey::Balance(bank.clone());
        let balance = Self::balance(env.clone(), bank.clone()) + amount;
        let persistent = env.storage().persistent();
        persistent.set(&key, &balance);
        persistent.extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
        Deposited { bank, amount }.publish(&env);
    }

    /// The bank's settlement balance; 0 for a bank that never deposited.
    pub fn balance(env: Env, bank: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(bank))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
