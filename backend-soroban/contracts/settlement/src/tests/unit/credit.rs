//! Intraday credit as a collateralised repo (ADR-0011): A14 `SetCollateral`, A12
//! `Credit` under Repo with MintBurn, A13 `Repay`, and ADR-0014's penalty repo, which
//! replaces A18's conversion to overnight credit and is repaid as A20 is.
//!
//! Collateral is a value the central bank sets, after haircuts, as in A14; there is no
//! collateral token. `Credit::ovn` holds penalty repos.
//!
//! Where the model differs:
//! - A12's guard `phase = Open` does not apply, since there is no business day
//!   (ADR-0013); credit can be opened at any time.
//! - A18 converted every repo at the close. With no close (ADR-0013), each repo converts
//!   once its own term has passed, when anyone calls `convert_overdue` (ADR-0014).
//! - The penalty rate is recorded on the repo but not charged: decided with the user on
//!   2026-10-24 (status and rate only, no interest accrual). Conversion therefore mints
//!   and burns nothing.
use crate::tests::support::{default_config, Setup};
use crate::*;

const NORMAL: Priority = Priority::Normal;

fn credit(cr: i128, ovn: i128, coll: i128) -> Credit {
    Credit { cr, ovn, coll }
}

// ---------------------------------------------------------------------------------------
// A14 set_collateral

/// SC-A14-01. A14: the central bank sets a bank's collateral value; a bank with none has
/// an all-zero credit position. Collateral is per bank: setting one bank's leaves
/// another's as it was.
#[test]
fn the_central_bank_sets_a_banks_collateral() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    assert_eq!(client.credit(setup.bank(0)), credit(0, 0, 0));

    client.set_collateral(setup.bank(0), &100);

    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(CollateralSet {
            bank: setup.bank(0).clone(),
            value: 100,
        })]
    );
    assert_eq!(client.credit(setup.bank(0)), credit(0, 0, 100));
    assert_eq!(client.credit(setup.bank(1)), credit(0, 0, 0));

    client.set_collateral(setup.bank(1), &40);
    assert_eq!(client.credit(setup.bank(0)), credit(0, 0, 100));
    assert_eq!(client.credit(setup.bank(1)), credit(0, 0, 40));
}

/// SC-A14-02. A14's guard `x ≥ 0`: zero releases all collateral; a negative value is
/// `InvalidAmount`.
#[test]
fn collateral_can_be_zero_but_not_negative() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    client.set_collateral(setup.bank(0), &0);
    assert_eq!(client.credit(setup.bank(0)).coll, 0);
    client.set_collateral(setup.bank(0), &70);
    for value in [-1, i128::MIN] {
        assert_eq!(
            client.try_set_collateral(setup.bank(0), &value),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(client.credit(setup.bank(0)), credit(0, 0, 70));
}

/// SC-A14-03. A14 under collat, S21: collateral cannot fall below the credit it backs,
/// `cr + ovn`. Exactly the credit is allowed; one below is `CollateralBelowCredit`.
#[test]
fn collateral_cannot_fall_below_the_credit_it_backs() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    client.open_repo(setup.bank(0), &60);

    assert_eq!(
        client.try_set_collateral(setup.bank(0), &59),
        Err(Ok(Error::CollateralBelowCredit))
    );
    assert_eq!(client.credit(setup.bank(0)), credit(60, 0, 100));
    client.set_collateral(setup.bank(0), &60);
    assert_eq!(client.credit(setup.bank(0)), credit(60, 0, 60));
}

// ---------------------------------------------------------------------------------------
// A12 open_repo

/// SC-A12-01. A12 under Repo: the central bank mints the credit into the contract and
/// credits the bank. The money is new (`issued` grows), and the tokens the contract
/// holds still equal its balances (S1, S4; ADR-0011).
#[test]
fn a_repo_mints_cash_into_the_contract_and_credits_the_bank() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    setup.at(500);

    let id = client.open_repo(setup.bank(0), &60);

    assert_eq!(id, 0);
    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(RepoOpened {
            id,
            bank: setup.bank(0).clone(),
            amount: 60,
        })]
    );
    assert_eq!(client.balance(setup.bank(0)), 60);
    assert_eq!(setup.token().balance(&setup.contract), 60);
    assert_eq!(client.credit(setup.bank(0)), credit(60, 0, 100));
    assert_eq!(
        client.repo(&id),
        Some(Repo {
            id,
            bank: setup.bank(0).clone(),
            amount: 60,
            outstanding: 60,
            opened_at: 500,
            status: RepoStatus::Intraday,
            rate_bps: 0,
        })
    );
    setup.assert_conserved();
}

/// SC-A12-02. S17: credit up to exactly the collateral is allowed, across several
/// repos; one unit more is `CreditExceedsCollateral` and nothing is minted.
#[test]
fn credit_may_reach_but_not_exceed_the_collateral() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    assert_eq!(client.open_repo(setup.bank(0), &60), 0);
    assert_eq!(client.open_repo(setup.bank(0), &40), 1);

    assert_eq!(
        client.try_open_repo(setup.bank(0), &1),
        Err(Ok(Error::CreditExceedsCollateral))
    );
    assert_eq!(client.credit(setup.bank(0)), credit(100, 0, 100));
    assert_eq!(setup.token().balance(&setup.contract), 100);
    assert_eq!(client.repo(&2), None);
}

/// SC-A12-03. A bank with no collateral gets no credit.
#[test]
fn a_bank_with_no_collateral_gets_no_credit() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    assert_eq!(
        client.try_open_repo(setup.bank(0), &1),
        Err(Ok(Error::CreditExceedsCollateral))
    );
    assert_eq!(client.credit(setup.bank(0)), credit(0, 0, 0));
    assert_eq!(client.balance(setup.bank(0)), 0);
    assert_eq!(setup.token().balance(&setup.contract), 0);
    assert_eq!(client.repo(&0), None);
}

/// SC-A12-04. A12's guard `x > 0`: a zero or negative repo is `InvalidAmount`.
#[test]
fn a_zero_or_negative_repo_is_refused() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    for amount in [0, -1, i128::MIN] {
        assert_eq!(
            client.try_open_repo(setup.bank(0), &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(client.credit(setup.bank(0)), credit(0, 0, 100));
}

/// SC-A12-05. `i128` boundary: with collateral `i128::MAX`, a repo of `i128::MAX` is
/// allowed, and one more unit is refused without overflowing `cr + ovn + x`.
#[test]
fn credit_at_i128_max_is_checked_without_overflow() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &i128::MAX);
    client.open_repo(setup.bank(0), &i128::MAX);
    assert_eq!(
        client.try_open_repo(setup.bank(0), &1),
        Err(Ok(Error::CreditExceedsCollateral))
    );
    assert_eq!(client.balance(setup.bank(0)), i128::MAX);
    setup.assert_conserved();
}

/// SC-A12-06. The new money settles the bank's queued payment in the same call (L1 with
/// δ = 0, S9; ADR-0010, ADR-0011).
#[test]
fn a_repo_releases_the_banks_queue() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);
    client.set_collateral(setup.bank(0), &100);

    let repo = client.open_repo(setup.bank(0), &50);

    assert_eq!(
        setup.our_events(),
        std::vec![
            setup.ev(RepoOpened {
                id: repo,
                bank: setup.bank(0).clone(),
                amount: 50,
            }),
            setup.ev(Settled {
                id,
                from: setup.bank(0).clone(),
                to: setup.bank(1).clone(),
                amount: 50,
            }),
        ]
    );
    assert_eq!(setup.balances(), std::vec![0, 50]);
    setup.assert_conserved();
}

// ---------------------------------------------------------------------------------------
// A13 repay

/// SC-A13-01. A13 under Repo with MintBurn: a partial repayment debits the bank, burns
/// the cash from the contract and lowers `cr` (S1, S4; ADR-0011).
#[test]
fn a_partial_repayment_burns_cash_and_lowers_the_credit() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);

    client.repay(setup.bank(0), &id, &20);

    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(RepoRepaid {
            id,
            amount: 20,
            outstanding: 40,
        })]
    );
    assert_eq!(client.balance(setup.bank(0)), 40);
    assert_eq!(setup.token().balance(&setup.contract), 40);
    assert_eq!(client.credit(setup.bank(0)), credit(40, 0, 100));
    let repo = client.repo(&id).unwrap();
    assert_eq!((repo.outstanding, repo.status), (40, RepoStatus::Intraday));
    setup.assert_conserved();
}

/// SC-A13-02. Repaying the whole outstanding amount closes the repo and frees the
/// collateral behind it.
#[test]
fn a_full_repayment_closes_the_repo_and_frees_the_collateral() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);

    client.repay(setup.bank(0), &id, &60);

    let repo = client.repo(&id).unwrap();
    assert_eq!((repo.outstanding, repo.status), (0, RepoStatus::Repaid));
    assert_eq!(client.credit(setup.bank(0)), credit(0, 0, 100));
    assert_eq!(setup.token().balance(&setup.contract), 0);
    client.set_collateral(setup.bank(0), &0);
    setup.assert_conserved();
}

/// SC-A13-03. A13's actor is the owner or the central bank (S6): the central bank may
/// repay on the bank's behalf, debiting the bank.
#[test]
fn the_central_bank_may_repay_on_the_banks_behalf() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);

    client.repay(&setup.cb, &id, &60);

    assert_eq!(client.balance(setup.bank(0)), 0);
    assert_eq!(client.repo(&id).unwrap().status, RepoStatus::Repaid);
}

/// SC-A13-04. S6: anyone else is `NotAuthorized`, even with their own authorization.
#[test]
fn a_third_party_cannot_repay() {
    let setup = Setup::funded(&[0, 100]);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    assert_eq!(
        client.try_repay(setup.bank(1), &id, &10),
        Err(Ok(Error::NotAuthorized))
    );
    assert_eq!(client.repo(&id).unwrap().outstanding, 60);
    assert_eq!(setup.balances(), std::vec![60, 100]);
}

/// SC-A13-05. A13's guard `x ≤ cr`: one more than the outstanding amount is
/// `RepayExceedsRepo`, and a repaid repo has nothing left to repay.
#[test]
fn repaying_more_than_is_outstanding_is_refused() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    setup.mint(setup.bank(0), 100);
    client.deposit(setup.bank(0), &100);
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);

    assert_eq!(
        client.try_repay(setup.bank(0), &id, &61),
        Err(Ok(Error::RepayExceedsRepo))
    );
    client.repay(setup.bank(0), &id, &60);
    assert_eq!(
        client.try_repay(setup.bank(0), &id, &1),
        Err(Ok(Error::RepayExceedsRepo))
    );
    assert_eq!(client.balance(setup.bank(0)), 100);
}

/// SC-A13-06. A13's guard `bal − x ≥ −lim` with `lim` = 0: a bank that spent the money
/// can repay exactly its balance, but not one unit more (`InsufficientFunds`).
#[test]
fn a_bank_cannot_repay_more_than_its_balance() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);

    assert_eq!(
        client.try_repay(setup.bank(0), &id, &11),
        Err(Ok(Error::InsufficientFunds))
    );
    client.repay(setup.bank(0), &id, &10);
    assert_eq!(client.balance(setup.bank(0)), 0);
    assert_eq!(client.repo(&id).unwrap().outstanding, 50);
    setup.assert_conserved();
}

/// SC-A13-07. A zero or negative repayment is `InvalidAmount`.
#[test]
fn a_zero_or_negative_repayment_is_refused() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    for amount in [0, -1, i128::MIN] {
        assert_eq!(
            client.try_repay(setup.bank(0), &id, &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(client.repo(&id).unwrap().outstanding, 60);
    assert_eq!(client.credit(setup.bank(0)), credit(60, 0, 100));
    assert_eq!(client.balance(setup.bank(0)), 60);
    assert_eq!(setup.token().balance(&setup.contract), 60);
}

/// SC-A13-08. A repo id that was never issued is `UnknownRepo`.
#[test]
fn repaying_an_unknown_repo_is_refused() {
    let setup = Setup::new(1, 0);
    assert_eq!(
        setup.client().try_repay(setup.bank(0), &0, &1),
        Err(Ok(Error::UnknownRepo))
    );
}

// ---------------------------------------------------------------------------------------
// ADR-0014: the term, the penalty repo, and A20 for its repayment

/// SC-A20-01. ADR-0014: once its term has passed, anyone converts an unpaid repo into a
/// penalty repo. Its outstanding amount moves from `cr` to `ovn`, it records the
/// configured penalty rate, and it stays collateralised (S21).
#[test]
fn an_overdue_repo_becomes_a_penalty_repo() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    setup.at(1_000);
    let id = client.open_repo(setup.bank(0), &60);
    client.repay(setup.bank(0), &id, &20);
    setup.at(1_000 + default_config().repo_term_secs + 1);

    client.convert_overdue(&id);

    assert_eq!(
        setup.our_events(),
        std::vec![setup.ev(RepoPenalised {
            id,
            rate_bps: default_config().penalty_rate_bps,
        })]
    );
    let repo = client.repo(&id).unwrap();
    assert_eq!(
        (repo.status, repo.rate_bps, repo.outstanding),
        (RepoStatus::Penalty, 500, 40)
    );
    assert_eq!(client.credit(setup.bank(0)), credit(0, 40, 100));
    // The money stays where it is: conversion mints and burns nothing.
    assert_eq!(client.balance(setup.bank(0)), 40);
    setup.assert_conserved();
}

/// SC-A20-02. The term's boundary: exactly at `opened_at + repo_term_secs` the repo is
/// not overdue (`NotOverdue`), which stays correct when two ledgers share a timestamp
/// (CAP-88, handbook 09 §3).
#[test]
fn a_repo_exactly_at_its_term_is_not_overdue() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    setup.at(1_000);
    let id = client.open_repo(setup.bank(0), &60);
    for time in [1_000, 1_000 + default_config().repo_term_secs] {
        setup.at(time);
        assert_eq!(client.try_convert_overdue(&id), Err(Ok(Error::NotOverdue)));
    }
    assert_eq!(client.credit(setup.bank(0)), credit(60, 0, 100));
}

/// SC-A20-03. The term and the rate are configuration values (ADR-0014).
#[test]
fn the_term_and_the_penalty_rate_are_configurable() {
    let setup = Setup::with_config(
        1,
        0,
        Config {
            repo_term_secs: 10,
            penalty_rate_bps: 1_234,
            ..default_config()
        },
    );
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    setup.at(0);
    let id = client.open_repo(setup.bank(0), &60);
    setup.at(11);
    client.convert_overdue(&id);
    assert_eq!(client.repo(&id).unwrap().rate_bps, 1_234);
}

/// SC-A20-04. A penalty repo converts once only: `AlreadyPenalty`.
#[test]
fn a_penalty_repo_cannot_be_converted_again() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    setup.at(default_config().repo_term_secs + 1);
    client.convert_overdue(&id);
    assert_eq!(
        client.try_convert_overdue(&id),
        Err(Ok(Error::AlreadyPenalty))
    );
    assert_eq!(client.credit(setup.bank(0)), credit(0, 60, 100));
}

/// SC-A20-05. A repaid repo is never overdue: `NotOverdue`.
#[test]
fn a_repaid_repo_is_never_overdue() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    client.repay(setup.bank(0), &id, &60);
    setup.at(default_config().repo_term_secs + 1);
    assert_eq!(client.try_convert_overdue(&id), Err(Ok(Error::NotOverdue)));
}

/// SC-A20-06. A repo id that was never issued is `UnknownRepo`.
#[test]
fn converting_an_unknown_repo_is_refused() {
    let setup = Setup::new(1, 0);
    assert_eq!(
        setup.client().try_convert_overdue(&9),
        Err(Ok(Error::UnknownRepo))
    );
}

/// SC-A20-07. A20 for a penalty repo: repayment burns cash and lowers `ovn`, and the
/// repo closes once paid (S1, S4).
#[test]
fn a_penalty_repo_is_repaid_by_a_burn() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    setup.at(default_config().repo_term_secs + 1);
    client.convert_overdue(&id);

    client.repay(setup.bank(0), &id, &25);
    assert_eq!(client.credit(setup.bank(0)), credit(0, 35, 100));
    assert_eq!(client.repo(&id).unwrap().status, RepoStatus::Penalty);

    client.repay(setup.bank(0), &id, &35);
    assert_eq!(client.credit(setup.bank(0)), credit(0, 0, 100));
    assert_eq!(client.repo(&id).unwrap().status, RepoStatus::Repaid);
    assert_eq!(setup.token().balance(&setup.contract), 0);
    setup.assert_conserved();
}

/// SC-A20-08. S21: penalty repos count against the collateral. A new repo must fit in
/// `coll − cr − ovn`, and the collateral cannot fall below `cr + ovn` (C-DF-028).
#[test]
fn penalty_repos_stay_collateralised() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    setup.at(default_config().repo_term_secs + 1);
    client.convert_overdue(&id);

    assert_eq!(
        client.try_open_repo(setup.bank(0), &41),
        Err(Ok(Error::CreditExceedsCollateral))
    );
    client.open_repo(setup.bank(0), &40);
    assert_eq!(client.credit(setup.bank(0)), credit(40, 60, 100));
    assert_eq!(
        client.try_set_collateral(setup.bank(0), &99),
        Err(Ok(Error::CollateralBelowCredit))
    );
}
