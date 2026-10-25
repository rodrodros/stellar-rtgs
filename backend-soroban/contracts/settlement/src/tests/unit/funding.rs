//! Configuration and A11 `LiquidityTransfer`: the constructor, `deposit` and `withdraw`.
//!
//! Definition §5.5 maps a SAC transfer into or out of the contract to A11, between two
//! accounts of the same bank: its trustline holding of the cash token and its settlement
//! balance in the contract. The money moves between them, and none is created, so the
//! model's `issued` is unchanged. The contract checks the form of S1 it can see
//! (ADR-0004): the tokens it holds equal the sum of the settlement balances.
//!
//! A11's guard against the model:
//! - `x > 0`;
//! - `bal(a) − x ≥ −lim(a)` with `lim` = 0 (ADR-0011). The SAC checks it for a deposit,
//!   and the contract for a withdrawal.
//!
//! Where the model differs: A11's guard `phase = Open` does not apply, since there is no
//! business day (ADR-0013).
use crate::tests::support::{default_config, Setup};
use crate::*;

// ---------------------------------------------------------------------------------------
// Configuration

/// SC-A11-13. The provisional decisions are single configuration values, readable back
/// (ADR-0010, ADR-0014, ADR-0015), and the central bank is recorded as the contract's
/// credit authority (S6 for A12–A14; ADR-0011).
#[test]
fn the_constructor_records_the_configuration_and_the_central_bank() {
    let setup = Setup::new(0, 0);
    let client = setup.client();
    assert_eq!(client.config(), default_config());
    assert_eq!(client.central_bank(), setup.cb);
}

// ---------------------------------------------------------------------------------------
// deposit: A11 from the bank's trustline to its settlement balance

/// SC-A11-01. A11: a deposit moves cash tokens into the contract and credits the bank's
/// settlement balance by the same amount (S1, S4; ADR-0003, ADR-0004).
#[test]
fn deposit_moves_tokens_into_the_contract_and_credits_the_bank() {
    let setup = Setup::new(1, 1_000);
    let client = setup.client();

    client.deposit(setup.bank(0), &600);

    // Our one event: the SAC's transfer event comes from the token contract.
    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(Deposited {
            bank: setup.bank(0).clone(),
            amount: 600,
        })]
    );
    assert_eq!(setup.token().balance(setup.bank(0)), 400);
    assert_eq!(setup.token().balance(&setup.contract), 600);
    assert_eq!(client.balance(setup.bank(0)), 600);
    setup.assert_conserved();
}

/// SC-A11-02. A11's guard at its boundary: depositing exactly what the bank holds
/// succeeds, and deposits add up. Two banks, two deposits each, so S1 is checked over a
/// sum, not one balance (review finding H2).
#[test]
fn deposit_of_exactly_the_banks_holding_succeeds_and_deposits_add_up() {
    let setup = Setup::new(2, 1_000);
    let client = setup.client();
    client.deposit(setup.bank(0), &400);
    client.deposit(setup.bank(1), &250);
    client.deposit(setup.bank(0), &600);
    client.deposit(setup.bank(1), &50);
    assert_eq!(setup.balances(), std::vec![1_000, 300]);
    assert_eq!(setup.token().balance(setup.bank(0)), 0);
    assert_eq!(setup.token().balance(setup.bank(1)), 700);
    assert_eq!(setup.token().balance(&setup.contract), 1_300);
    setup.assert_conserved();
}

/// SC-A11-03. A11's guard `x > 0`: a zero or negative deposit is refused with
/// `InvalidAmount`, and nothing moves.
#[test]
fn deposit_of_zero_or_a_negative_amount_is_refused() {
    let setup = Setup::new(1, 1_000);
    let client = setup.client();
    for amount in [0, -1, i128::MIN] {
        assert_eq!(
            client.try_deposit(setup.bank(0), &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(client.balance(setup.bank(0)), 0);
    assert_eq!(setup.token().balance(setup.bank(0)), 1_000);
    setup.assert_conserved();
}

/// SC-A11-04. A11's guard `bal − x ≥ 0` on the trustline side: depositing one more than
/// the bank holds is refused by the SAC, reported as the contract's own
/// `TokenTransferFailed`, and nothing moves.
#[test]
fn deposit_of_one_more_than_the_bank_holds_is_refused() {
    let setup = Setup::new(1, 1_000);
    let client = setup.client();
    assert_eq!(
        client.try_deposit(setup.bank(0), &1_001),
        Err(Ok(Error::TokenTransferFailed))
    );
    assert_eq!(client.balance(setup.bank(0)), 0);
    assert_eq!(setup.token().balance(setup.bank(0)), 1_000);
    setup.assert_conserved();
}

/// SC-A11-05. A11 at the `i128` boundary: once the contract holds `i128::MAX`, one more unit cannot
/// arrive. The SAC refuses it before the contract's own sum could overflow, so the
/// internal balances can never overflow either (S1 bounds them by the tokens held).
#[test]
fn deposit_that_would_overflow_the_contracts_holding_is_refused_by_the_sac() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    setup.mint(setup.bank(0), i128::MAX);
    setup.mint(setup.bank(1), 1);
    client.deposit(setup.bank(0), &i128::MAX);
    assert_eq!(client.balance(setup.bank(0)), i128::MAX);

    assert_eq!(
        client.try_deposit(setup.bank(1), &1),
        Err(Ok(Error::TokenTransferFailed))
    );
    assert_eq!(client.balance(setup.bank(1)), 0);
    assert_eq!(setup.token().balance(setup.bank(1)), 1);
    setup.assert_conserved();
}

/// SC-A11-14. §4.4's initial state: a bank that never deposited has `bal` = 0.
#[test]
fn balance_of_an_unknown_bank_is_zero() {
    let setup = Setup::new(1, 0);
    assert_eq!(setup.client().balance(setup.bank(0)), 0);
}

// ---------------------------------------------------------------------------------------
// withdraw: A11 from the settlement balance back to the bank's trustline

/// SC-A11-06. A11: a withdrawal debits the settlement balance and pays the cash tokens out of
/// the contract (S1, S4; ADR-0004).
#[test]
fn withdraw_debits_the_bank_and_pays_the_tokens_out() {
    let setup = Setup::funded(&[1_000]);
    let client = setup.client();

    client.withdraw(setup.bank(0), &300);

    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(Withdrawn {
            bank: setup.bank(0).clone(),
            amount: 300,
        })]
    );
    assert_eq!(client.balance(setup.bank(0)), 700);
    assert_eq!(setup.token().balance(setup.bank(0)), 300);
    assert_eq!(setup.token().balance(&setup.contract), 700);
    setup.assert_conserved();
}

/// SC-A11-07. A11's guard at its boundary: withdrawing exactly the balance leaves 0,
/// including at `i128::MAX` (S2).
#[test]
fn withdraw_of_exactly_the_balance_leaves_zero_even_at_i128_max() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    setup.mint(setup.bank(0), i128::MAX);
    client.deposit(setup.bank(0), &i128::MAX);

    client.withdraw(setup.bank(0), &i128::MAX);

    assert_eq!(client.balance(setup.bank(0)), 0);
    assert_eq!(setup.token().balance(setup.bank(0)), i128::MAX);
    setup.assert_conserved();
}

/// SC-A11-08. Withdrawing one more than the balance is refused with `InsufficientFunds`,
/// and nothing moves (S2: no credit line, ADR-0011).
#[test]
fn withdraw_of_one_more_than_the_balance_is_refused() {
    let setup = Setup::funded(&[1_000]);
    let client = setup.client();
    assert_eq!(
        client.try_withdraw(setup.bank(0), &1_001),
        Err(Ok(Error::InsufficientFunds))
    );
    assert_eq!(client.balance(setup.bank(0)), 1_000);
    assert_eq!(setup.token().balance(&setup.contract), 1_000);
    setup.assert_conserved();
}

/// SC-A11-09. A11's guard `x > 0`: a zero or negative withdrawal is refused with
/// `InvalidAmount`.
#[test]
fn withdraw_of_zero_or_a_negative_amount_is_refused() {
    let setup = Setup::funded(&[1_000]);
    let client = setup.client();
    for amount in [0, -1, i128::MIN] {
        assert_eq!(
            client.try_withdraw(setup.bank(0), &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(client.balance(setup.bank(0)), 1_000);
    setup.assert_conserved();
}

/// SC-A11-10. A11's guard with `bal` = 0: a bank that never deposited cannot withdraw.
#[test]
fn withdraw_by_a_bank_with_no_balance_is_refused() {
    let setup = Setup::new(1, 1_000);
    assert_eq!(
        setup.client().try_withdraw(setup.bank(0), &1),
        Err(Ok(Error::InsufficientFunds))
    );
}

/// SC-A11-11. Queued payments reserve nothing (ADR-0018): a withdrawal may spend money a
/// queued payment behind an uncovered head would need. The payment stays queued and
/// uncovered.
#[test]
fn withdraw_may_spend_what_a_queued_payment_would_need() {
    let setup = Setup::funded(&[50, 0]);
    let client = setup.client();
    let head = client.submit(setup.bank(0), setup.bank(1), &60, &Priority::Normal);
    let behind = client.submit(setup.bank(0), setup.bank(1), &10, &Priority::Normal);

    client.withdraw(setup.bank(0), &45);
    client.revoke(&head);

    assert_eq!(client.balance(setup.bank(0)), 5);
    assert_eq!(setup.queue(0, Priority::Normal), std::vec![behind]);
    assert_eq!(client.payment(&behind).unwrap().status, Status::Queued);
    setup.assert_conserved();
}

// ---------------------------------------------------------------------------------------
// The issuer's controls (ADR-0003)

/// SC-A11-15. ADR-0003: the issuer can revoke a bank's authorization to hold the cash
/// token. A deauthorized bank's deposit is refused by the SAC, reported as
/// `TokenTransferFailed`, and nothing moves (S1).
#[test]
fn a_deauthorized_bank_cannot_deposit() {
    let setup = Setup::new(1, 1_000);
    let client = setup.client();
    setup.admin().set_authorized(setup.bank(0), &false);

    assert_eq!(
        client.try_deposit(setup.bank(0), &600),
        Err(Ok(Error::TokenTransferFailed))
    );

    assert_eq!(client.balance(setup.bank(0)), 0);
    assert_eq!(setup.token().balance(setup.bank(0)), 1_000);
    setup.assert_conserved();
}

/// SC-A11-16. ADR-0003: a withdrawal to a deauthorized bank is refused by the SAC,
/// reported as `TokenTransferFailed`, and the settlement balance is unchanged (S1, S2).
#[test]
fn a_withdrawal_to_a_deauthorized_bank_is_refused() {
    let setup = Setup::funded(&[1_000]);
    let client = setup.client();
    setup.admin().set_authorized(setup.bank(0), &false);

    assert_eq!(
        client.try_withdraw(setup.bank(0), &300),
        Err(Ok(Error::TokenTransferFailed))
    );

    assert_eq!(client.balance(setup.bank(0)), 1_000);
    assert_eq!(setup.token().balance(&setup.contract), 1_000);
    setup.assert_conserved();
}
