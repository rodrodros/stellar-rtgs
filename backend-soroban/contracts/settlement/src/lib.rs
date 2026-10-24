//! The RTGS settlement contract: one contract holds the cash token and keeps every
//! bank's settlement balance (ADR-0004).
//!
//! So far it has only deposits. Payments, queues, offsetting and credit come in later
//! tasks, test first (TESTING.md).
#![no_std]

use soroban_sdk::{contract, contractevent, contractimpl, Address, Env};

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
    pub fn __constructor(_env: Env, _token: Address) {
        todo!()
    }

    /// Moves `amount` of the cash token from `bank` into this contract and credits the
    /// bank's settlement balance.
    pub fn deposit(_env: Env, _bank: Address, _amount: i128) {
        todo!()
    }

    /// The bank's settlement balance; 0 for a bank that never deposited.
    pub fn balance(_env: Env, _bank: Address) -> i128 {
        todo!()
    }
}

#[cfg(test)]
mod test;
