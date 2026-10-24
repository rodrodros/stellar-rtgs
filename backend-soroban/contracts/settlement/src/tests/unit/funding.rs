//! Configuration and funding: the constructor, `deposit` and `withdraw`. Deposit and
//! withdrawal are not model actions; from the model's view money enters or leaves the
//! system, as in A15 and A16, so `issued` changes by the amount and S1 still holds.
use crate::tests::support::{default_config, Setup};
use crate::*;

// ---------------------------------------------------------------------------------------
// Configuration

/// The provisional decisions are single configuration values, readable back (ADR-0014,
/// ADR-0015), and the central bank is recorded as the contract's credit authority.
#[test]
fn the_constructor_records_the_configuration_and_the_central_bank() {
    let s = Setup::new(0, 0);
    let c = s.client();
    assert_eq!(c.config(), default_config());
    assert_eq!(c.central_bank(), s.cb);
}

// ---------------------------------------------------------------------------------------
// deposit

/// SC-F-01. A deposit moves cash tokens into the contract and credits the bank's
/// settlement balance by the same amount (S1, S4; ADR-0003, ADR-0004).
#[test]
fn deposit_moves_tokens_into_the_contract_and_credits_the_bank() {
    let s = Setup::new(1, 1_000);
    let c = s.client();

    c.deposit(s.bank(0), &600);

    // Our one event: the SAC's transfer event comes from the token contract.
    assert_eq!(
        s.our_events(),
        std::vec![s.ev(Deposited {
            bank: s.bank(0).clone(),
            amount: 600,
        })]
    );
    assert_eq!(s.token().balance(s.bank(0)), 400);
    assert_eq!(s.token().balance(&s.contract), 600);
    assert_eq!(c.balance(s.bank(0)), 600);
    s.assert_conserved();
}

/// SC-F-02. Depositing exactly what the bank holds succeeds; deposits add up.
#[test]
fn deposit_of_exactly_the_banks_holding_succeeds_and_deposits_add_up() {
    let s = Setup::new(1, 1_000);
    let c = s.client();
    c.deposit(s.bank(0), &400);
    c.deposit(s.bank(0), &600);
    assert_eq!(c.balance(s.bank(0)), 1_000);
    assert_eq!(s.token().balance(s.bank(0)), 0);
    s.assert_conserved();
}

/// SC-F-03. A zero or negative deposit is refused with `InvalidAmount`, and nothing
/// moves (order amounts are positive, §4.1).
#[test]
fn deposit_of_zero_or_a_negative_amount_is_refused() {
    let s = Setup::new(1, 1_000);
    let c = s.client();
    for amount in [0, -1, i128::MIN] {
        assert_eq!(
            c.try_deposit(s.bank(0), &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(c.balance(s.bank(0)), 0);
    assert_eq!(s.token().balance(s.bank(0)), 1_000);
    s.assert_conserved();
}

/// SC-F-04. Depositing one more than the bank holds is refused by the SAC, reported as
/// `TokenTransferFailed`, and nothing moves.
#[test]
fn deposit_of_one_more_than_the_bank_holds_is_refused() {
    let s = Setup::new(1, 1_000);
    let c = s.client();
    assert_eq!(
        c.try_deposit(s.bank(0), &1_001),
        Err(Ok(Error::TokenTransferFailed))
    );
    assert_eq!(c.balance(s.bank(0)), 0);
    assert_eq!(s.token().balance(s.bank(0)), 1_000);
    s.assert_conserved();
}

/// SC-F-05. `i128` overflow: once the contract holds `i128::MAX`, one more unit cannot
/// arrive. The SAC refuses it before the contract's own sum could overflow, so the
/// internal balances can never overflow either (S1 bounds them by the tokens held).
#[test]
fn deposit_that_would_overflow_the_contracts_holding_is_refused_by_the_sac() {
    let s = Setup::new(2, 0);
    let c = s.client();
    s.mint(s.bank(0), i128::MAX);
    s.mint(s.bank(1), 1);
    c.deposit(s.bank(0), &i128::MAX);
    assert_eq!(c.balance(s.bank(0)), i128::MAX);

    assert_eq!(
        c.try_deposit(s.bank(1), &1),
        Err(Ok(Error::TokenTransferFailed))
    );
    assert_eq!(c.balance(s.bank(1)), 0);
    assert_eq!(s.token().balance(s.bank(1)), 1);
    s.assert_conserved();
}

/// The balance of a bank that never deposited is 0.
#[test]
fn balance_of_an_unknown_bank_is_zero() {
    let s = Setup::new(1, 0);
    assert_eq!(s.client().balance(s.bank(0)), 0);
}

// ---------------------------------------------------------------------------------------
// withdraw

/// SC-F-06. A withdrawal debits the settlement balance and pays the cash tokens out of
/// the contract (S1, S4; ADR-0004).
#[test]
fn withdraw_debits_the_bank_and_pays_the_tokens_out() {
    let s = Setup::funded(&[1_000]);
    let c = s.client();

    c.withdraw(s.bank(0), &300);

    assert_eq!(
        s.our_events(),
        std::vec![s.ev(Withdrawn {
            bank: s.bank(0).clone(),
            amount: 300,
        })]
    );
    assert_eq!(c.balance(s.bank(0)), 700);
    assert_eq!(s.token().balance(s.bank(0)), 300);
    assert_eq!(s.token().balance(&s.contract), 700);
    s.assert_conserved();
}

/// SC-F-07. Withdrawing exactly the balance leaves 0, including at `i128::MAX`.
#[test]
fn withdraw_of_exactly_the_balance_leaves_zero_even_at_i128_max() {
    let s = Setup::new(1, 0);
    let c = s.client();
    s.mint(s.bank(0), i128::MAX);
    c.deposit(s.bank(0), &i128::MAX);

    c.withdraw(s.bank(0), &i128::MAX);

    assert_eq!(c.balance(s.bank(0)), 0);
    assert_eq!(s.token().balance(s.bank(0)), i128::MAX);
    s.assert_conserved();
}

/// SC-F-08. Withdrawing one more than the balance is refused with `InsufficientFunds`,
/// and nothing moves (S2: no credit line, ADR-0011).
#[test]
fn withdraw_of_one_more_than_the_balance_is_refused() {
    let s = Setup::funded(&[1_000]);
    let c = s.client();
    assert_eq!(
        c.try_withdraw(s.bank(0), &1_001),
        Err(Ok(Error::InsufficientFunds))
    );
    assert_eq!(c.balance(s.bank(0)), 1_000);
    assert_eq!(s.token().balance(&s.contract), 1_000);
    s.assert_conserved();
}

/// SC-F-09. A zero or negative withdrawal is refused with `InvalidAmount`.
#[test]
fn withdraw_of_zero_or_a_negative_amount_is_refused() {
    let s = Setup::funded(&[1_000]);
    let c = s.client();
    for amount in [0, -1, i128::MIN] {
        assert_eq!(
            c.try_withdraw(s.bank(0), &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(c.balance(s.bank(0)), 1_000);
    s.assert_conserved();
}

/// SC-F-10. A bank that never deposited cannot withdraw.
#[test]
fn withdraw_by_a_bank_with_no_balance_is_refused() {
    let s = Setup::new(1, 1_000);
    assert_eq!(
        s.client().try_withdraw(s.bank(0), &1),
        Err(Ok(Error::InsufficientFunds))
    );
}

/// SC-F-11. Queued payments reserve nothing (ADR-0018): a withdrawal may spend money a
/// queued payment behind an uncovered head would need. The payment stays queued and
/// uncovered.
#[test]
fn withdraw_may_spend_what_a_queued_payment_would_need() {
    let s = Setup::funded(&[50, 0]);
    let c = s.client();
    let head = c.submit(s.bank(0), s.bank(1), &60, &Priority::Normal);
    let behind = c.submit(s.bank(0), s.bank(1), &10, &Priority::Normal);

    c.withdraw(s.bank(0), &45);
    c.revoke(&head);

    assert_eq!(c.balance(s.bank(0)), 5);
    assert_eq!(s.queue(0, Priority::Normal), std::vec![behind]);
    assert_eq!(c.payment(&behind).unwrap().status, Status::Queued);
    s.assert_conserved();
}
