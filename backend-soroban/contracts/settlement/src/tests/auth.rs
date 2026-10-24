//! Authorization (S6): for each entry point, the exact tree its actor authorizes, and a
//! call with no authorization that fails. `mock_all_auths` alone would pass a contract
//! that forgot `require_auth` (C-HB-130).
use soroban_sdk::{
    testutils::{AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal, Symbol, Val, Vec,
};

use super::support::{default_config, Setup};
use crate::{Error, Priority, RepoStatus, Status};

const N: Priority = Priority::Normal;

/// One authorized call of `function` on `contract`, with its sub-invocations.
pub fn call(
    env: &Env,
    contract: &Address,
    function: &str,
    args: Vec<Val>,
    sub_invocations: std::vec::Vec<AuthorizedInvocation>,
) -> AuthorizedInvocation {
    AuthorizedInvocation {
        function: AuthorizedFunction::Contract((
            contract.clone(),
            Symbol::new(env, function),
            args,
        )),
        sub_invocations,
    }
}

/// S6. The bank authorizes one tree: `deposit`, with the token transfer the contract
/// makes on the bank's behalf.
#[test]
fn deposit_is_authorized_by_the_bank_for_itself_and_the_transfer() {
    let s = Setup::new(1, 1_000);
    s.client().deposit(s.bank(0), &600);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.bank(0).clone(),
            call(
                e,
                &s.contract,
                "deposit",
                (s.bank(0).clone(), 600_i128).into_val(e),
                std::vec![call(
                    e,
                    &s.token,
                    "transfer",
                    (s.bank(0).clone(), s.contract.clone(), 600_i128).into_val(e),
                    std::vec![],
                )],
            )
        )]
    );
}

/// S6. Without the bank's authorization the deposit fails and nothing moves.
#[test]
fn deposit_without_the_banks_authorization_fails() {
    let s = Setup::strict(1, 1_000);
    let c = s.client();
    assert!(c.try_deposit(s.bank(0), &600).is_err());
    assert_eq!(s.token().balance(s.bank(0)), 1_000);
    assert_eq!(s.token().balance(&s.contract), 0);
}

/// Calls `function` on the contract with only `who`'s authorization for exactly that
/// call, so a test can check that the wrong signer is refused.
fn only<'a>(s: &'a Setup, who: &'a Address, invoke: &'a MockAuthInvoke<'a>) {
    s.env.mock_auths(&[MockAuth {
        address: who,
        invoke,
    }]);
}

// ---------------------------------------------------------------------------------------
// withdraw

/// S6. The bank authorizes `withdraw` alone: the contract authorizes its own transfer
/// out as the direct caller (C-SC-074).
#[test]
fn withdraw_is_authorized_by_the_bank_alone() {
    let s = Setup::funded(&[1_000]);
    s.client().withdraw(s.bank(0), &300);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.bank(0).clone(),
            call(
                e,
                &s.contract,
                "withdraw",
                (s.bank(0).clone(), 300_i128).into_val(e),
                std::vec![],
            )
        )]
    );
}

/// S6. Without the bank's authorization the withdrawal fails and nothing moves.
#[test]
fn withdraw_without_the_banks_authorization_fails() {
    let s = Setup::funded(&[1_000]);
    s.env.set_auths(&[]);
    let c = s.client();
    assert!(c.try_withdraw(s.bank(0), &300).is_err());
    assert_eq!(c.balance(s.bank(0)), 1_000);
    assert_eq!(s.token().balance(&s.contract), 1_000);
}

// ---------------------------------------------------------------------------------------
// submit (A1)

/// S6 for A1: `mayDebit` holds only `(owner(a), a)`, so the sender authorizes the
/// submission, and nothing else, even when the payment settles at once.
#[test]
fn submit_is_authorized_by_the_sender_alone() {
    let s = Setup::funded(&[100, 0]);
    s.client().submit(s.bank(0), s.bank(1), &40, &N);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.bank(0).clone(),
            call(
                e,
                &s.contract,
                "submit",
                (s.bank(0).clone(), s.bank(1).clone(), 40_i128, N).into_val(e),
                std::vec![],
            )
        )]
    );
}

/// S6 for A1: with no authorization the submission fails and nothing is queued.
#[test]
fn submit_without_the_senders_authorization_fails() {
    let s = Setup::funded(&[100, 0]);
    s.env.set_auths(&[]);
    let c = s.client();
    assert!(c.try_submit(s.bank(0), s.bank(1), &40, &N).is_err());
    assert_eq!(s.balances(), std::vec![100, 0]);
    assert_eq!(c.queued_count(), 0);
}

/// S6 for A1: the receiver cannot submit a payment that debits the sender.
#[test]
fn the_receiver_cannot_submit_a_payment_from_the_sender() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    let args = (s.bank(0).clone(), s.bank(1).clone(), 40_i128, N).into_val(&s.env);
    let invoke = MockAuthInvoke {
        contract: &s.contract,
        fn_name: "submit",
        args,
        sub_invokes: &[],
    };
    only(&s, s.bank(1), &invoke);
    assert!(c.try_submit(s.bank(0), s.bank(1), &40, &N).is_err());
    assert_eq!(s.balances(), std::vec![100, 0]);
}

// ---------------------------------------------------------------------------------------
// revoke (A6) and reprioritise (A8)

/// S6 for A6: the sender authorizes the revocation.
#[test]
fn revoke_is_authorized_by_the_sender() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    c.revoke(&id);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.bank(0).clone(),
            call(e, &s.contract, "revoke", (id,).into_val(e), std::vec![])
        )]
    );
}

/// S6, S13 for A6: neither the receiver nor an unauthorized call can revoke; the payment
/// stays queued. Under UntilSettlement the receiver's consent is not needed, nor enough.
#[test]
fn only_the_sender_can_revoke() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    let invoke = MockAuthInvoke {
        contract: &s.contract,
        fn_name: "revoke",
        args: (id,).into_val(&s.env),
        sub_invokes: &[],
    };
    only(&s, s.bank(1), &invoke);
    assert!(c.try_revoke(&id).is_err());
    s.env.set_auths(&[]);
    assert!(c.try_revoke(&id).is_err());
    assert_eq!(c.payment(&id).unwrap().status, Status::Queued);
}

/// S6 for A8: the sender authorizes the reprioritisation.
#[test]
fn reprioritise_is_authorized_by_the_sender() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    c.reprioritise(&id, &Priority::Urgent);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.bank(0).clone(),
            call(
                e,
                &s.contract,
                "reprioritise",
                (id, Priority::Urgent).into_val(e),
                std::vec![],
            )
        )]
    );
}

/// S6 for A8: the receiver cannot reprioritise, nor can an unauthorized call.
#[test]
fn only_the_sender_can_reprioritise() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    let invoke = MockAuthInvoke {
        contract: &s.contract,
        fn_name: "reprioritise",
        args: (id, Priority::Urgent).into_val(&s.env),
        sub_invokes: &[],
    };
    only(&s, s.bank(1), &invoke);
    assert!(c.try_reprioritise(&id, &Priority::Urgent).is_err());
    s.env.set_auths(&[]);
    assert!(c.try_reprioritise(&id, &Priority::Urgent).is_err());
    assert_eq!(c.payment(&id).unwrap().priority, N);
}

// ---------------------------------------------------------------------------------------
// expire (A5) and convert_overdue (ADR-0014): the system's own steps

/// S6 for A5: rejection is `sys`'s step, so any keeper may trigger it with no
/// authorization at all (ADR-0015, M1: attributed to `sys` whoever triggers it).
#[test]
fn expire_needs_no_authorization() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    s.env.set_auths(&[]);
    s.at(default_config().expiry_secs + 1);

    c.expire(&id);

    assert!(s.env.auths().is_empty());
    assert_eq!(c.payment(&id).unwrap().status, Status::Expired);
}

/// S6: converting an overdue repo is a system step (ADR-0014); any keeper may trigger
/// it with no authorization.
#[test]
fn convert_overdue_needs_no_authorization() {
    let s = Setup::new(1, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    let id = c.open_repo(s.bank(0), &60);
    s.env.set_auths(&[]);
    s.at(default_config().repo_term_secs + 1);

    c.convert_overdue(&id);

    assert!(s.env.auths().is_empty());
    assert_eq!(c.repo(&id).unwrap().status, RepoStatus::Penalty);
}

// ---------------------------------------------------------------------------------------
// set_collateral (A14), open_repo (A12), repay (A13, A20)

/// S6 for A14: the central bank authorizes `set_collateral`.
#[test]
fn set_collateral_is_authorized_by_the_central_bank() {
    let s = Setup::new(1, 0);
    s.client().set_collateral(s.bank(0), &100);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.cb.clone(),
            call(
                e,
                &s.contract,
                "set_collateral",
                (s.bank(0).clone(), 100_i128).into_val(e),
                std::vec![],
            )
        )]
    );
}

/// S6 for A14: the bank cannot set its own collateral, nor can an unauthorized call.
#[test]
fn only_the_central_bank_can_set_collateral() {
    let s = Setup::new(1, 0);
    let c = s.client();
    let invoke = MockAuthInvoke {
        contract: &s.contract,
        fn_name: "set_collateral",
        args: (s.bank(0).clone(), 100_i128).into_val(&s.env),
        sub_invokes: &[],
    };
    only(&s, s.bank(0), &invoke);
    assert!(c.try_set_collateral(s.bank(0), &100).is_err());
    s.env.set_auths(&[]);
    assert!(c.try_set_collateral(s.bank(0), &100).is_err());
    s.env.mock_all_auths();
    assert_eq!(c.credit(s.bank(0)).coll, 0);
}

/// S6 for A12, D1: the central bank authorizes the repo, and in the same tree the SAC
/// mint that issues the money into the contract (ADR-0011: the issuer mints).
#[test]
fn open_repo_is_authorized_by_the_central_bank_with_the_mint() {
    let s = Setup::new(1, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    c.open_repo(s.bank(0), &60);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.cb.clone(),
            call(
                e,
                &s.contract,
                "open_repo",
                (s.bank(0).clone(), 60_i128).into_val(e),
                std::vec![call(
                    e,
                    &s.token,
                    "mint",
                    (s.contract.clone(), 60_i128).into_val(e),
                    std::vec![],
                )],
            )
        )]
    );
}

/// S6 for A12: the bank cannot give itself credit, nor can an unauthorized call; no
/// money is minted.
#[test]
fn only_the_central_bank_can_open_a_repo() {
    let s = Setup::new(1, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    let invoke = MockAuthInvoke {
        contract: &s.contract,
        fn_name: "open_repo",
        args: (s.bank(0).clone(), 60_i128).into_val(&s.env),
        sub_invokes: &[],
    };
    only(&s, s.bank(0), &invoke);
    assert!(c.try_open_repo(s.bank(0), &60).is_err());
    s.env.set_auths(&[]);
    assert!(c.try_open_repo(s.bank(0), &60).is_err());
    assert_eq!(s.token().balance(&s.contract), 0);
    assert_eq!(c.balance(s.bank(0)), 0);
}

/// S6 for A13: the repaying actor authorizes `repay` alone; the contract burns its own
/// tokens as the direct caller, so the burn needs no one else's authorization.
#[test]
fn repay_is_authorized_by_the_actor_alone() {
    let s = Setup::new(1, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    let id = c.open_repo(s.bank(0), &60);
    c.repay(s.bank(0), &id, &20);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.bank(0).clone(),
            call(
                e,
                &s.contract,
                "repay",
                (s.bank(0).clone(), id, 20_i128).into_val(e),
                std::vec![],
            )
        )]
    );
}

/// S6 for A13: naming the bank as the actor without its authorization fails, and so does
/// naming the central bank without the central bank's. Nothing is burned.
#[test]
fn repay_without_the_actors_authorization_fails() {
    let s = Setup::new(1, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    let id = c.open_repo(s.bank(0), &60);
    s.env.set_auths(&[]);
    assert!(c.try_repay(s.bank(0), &id, &20).is_err());
    assert!(c.try_repay(&s.cb, &id, &20).is_err());
    assert_eq!(s.token().balance(&s.contract), 60);
    assert_eq!(c.repo(&id).unwrap().outstanding, 60);
}

/// S6: an authorized third party is refused by the contract's own rule, not just by
/// auth: `NotAuthorized`.
#[test]
fn an_authorized_third_party_is_still_not_authorized_to_repay() {
    let s = Setup::new(2, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    let id = c.open_repo(s.bank(0), &60);
    assert_eq!(
        c.try_repay(s.bank(1), &id, &20),
        Err(Ok(Error::NotAuthorized))
    );
}
