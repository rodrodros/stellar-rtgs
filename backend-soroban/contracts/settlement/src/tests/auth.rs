//! Authorization (S6): for each entry point, the exact tree its actor authorizes, and the
//! calls that must fail without it.
//!
//! `mock_all_auths` alone would pass a contract that forgot `require_auth` (C-HB-130), so
//! each positive test asserts the whole `env.auths()` tree. A failure test cannot rest on
//! `is_err()` either: a missing authorization and a `todo!()` panic return the same host
//! error, `Error(Context, InvalidAction)`. So each failure test (1) asserts that error,
//! (2) asserts that nothing changed, and (3) makes the identical call with exactly the
//! right signer's tree and asserts that it succeeds. Only the authorization differs
//! between (1) and (3), so the failure in (1) was the missing authorization.
use soroban_sdk::{
    testutils::{AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke},
    xdr::{ScErrorCode, ScErrorType},
    Address, Env, IntoVal, Symbol, Val, Vec,
};

use super::support::{default_config, Setup};
use crate::{Error, Priority, RepoStatus, Status};

const N: Priority = Priority::Normal;
const U: Priority = Priority::Urgent;

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

/// What the host returns for a call whose authorization is missing or wrong.
fn auth_failure() -> soroban_sdk::Error {
    soroban_sdk::Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}

/// Invokes `function(args)` on the contract and returns the raw host error it fails with.
/// The generated client's `try_` methods reduce every host error to `Abort`.
fn host_error(s: &Setup, function: &str, args: Vec<Val>) -> soroban_sdk::Error {
    match s.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &s.contract,
        &Symbol::new(&s.env, function),
        args,
    ) {
        Err(Ok(error)) => error,
        other => panic!("{function} should fail with a host error, got {other:?}"),
    }
}

/// Mocks exactly one authorization: `who` signs `function(args)` on the contract, with
/// `sub_invokes` beneath it. Nothing else is authorized.
fn authorize(
    s: &Setup,
    who: &Address,
    function: &str,
    args: Vec<Val>,
    sub_invokes: &[MockAuthInvoke],
) {
    s.env.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke {
            contract: &s.contract,
            fn_name: function,
            args,
            sub_invokes,
        },
    }]);
}

// ---------------------------------------------------------------------------------------
// deposit and withdraw (A11)

/// SC-A11-12. S6 for A11: the bank authorizes one tree, `deposit`, with the token
/// transfer the contract makes on the bank's behalf.
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

/// SC-A11-12. S6 for A11: without the bank's authorization the deposit fails and nothing
/// moves; with exactly the bank's tree it succeeds.
#[test]
fn deposit_without_the_banks_authorization_fails() {
    let s = Setup::strict(1, 1_000);
    let e = &s.env;
    let args: Vec<Val> = (s.bank(0).clone(), 600_i128).into_val(e);

    assert_eq!(host_error(&s, "deposit", args.clone()), auth_failure());
    assert_eq!(s.token().balance(s.bank(0)), 1_000);
    assert_eq!(s.token().balance(&s.contract), 0);
    assert_eq!(s.client().balance(s.bank(0)), 0);

    let transfer = MockAuthInvoke {
        contract: &s.token,
        fn_name: "transfer",
        args: (s.bank(0).clone(), s.contract.clone(), 600_i128).into_val(e),
        sub_invokes: &[],
    };
    authorize(&s, s.bank(0), "deposit", args, &[transfer]);
    s.client().deposit(s.bank(0), &600);
    assert_eq!(s.client().balance(s.bank(0)), 600);
}

/// SC-A11-12. S6 for A11: the bank authorizes `withdraw` alone; the contract authorizes
/// its own transfer out as the direct caller (C-SC-074).
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

/// SC-A11-12. S6 for A11: without the bank's authorization the withdrawal fails and
/// nothing moves; with exactly the bank's tree it succeeds.
#[test]
fn withdraw_without_the_banks_authorization_fails() {
    let s = Setup::funded(&[1_000]);
    s.env.set_auths(&[]);
    let c = s.client();
    let args: Vec<Val> = (s.bank(0).clone(), 300_i128).into_val(&s.env);

    assert_eq!(host_error(&s, "withdraw", args.clone()), auth_failure());
    assert_eq!(c.balance(s.bank(0)), 1_000);
    assert_eq!(s.token().balance(&s.contract), 1_000);

    authorize(&s, s.bank(0), "withdraw", args, &[]);
    c.withdraw(s.bank(0), &300);
    assert_eq!(c.balance(s.bank(0)), 700);
}

// ---------------------------------------------------------------------------------------
// submit (A1)

/// SC-A01-16. S6 for A1: `mayDebit` holds only `(owner(a), a)`, so the sender authorizes
/// the submission, and nothing else, even when the payment settles at once.
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

/// SC-A01-16. S6 for A1: with no authorization the submission fails, nothing settles and
/// nothing is queued; with exactly the sender's tree it settles.
#[test]
fn submit_without_the_senders_authorization_fails() {
    let s = Setup::funded(&[100, 0]);
    s.env.set_auths(&[]);
    let c = s.client();
    let args: Vec<Val> = (s.bank(0).clone(), s.bank(1).clone(), 40_i128, N).into_val(&s.env);

    assert_eq!(host_error(&s, "submit", args.clone()), auth_failure());
    assert_eq!(s.balances(), std::vec![100, 0]);
    assert_eq!(c.queued_count(), 0);
    assert_eq!(c.payment(&0), None);

    authorize(&s, s.bank(0), "submit", args, &[]);
    c.submit(s.bank(0), s.bank(1), &40, &N);
    assert_eq!(s.balances(), std::vec![60, 40]);
}

/// SC-A01-16. S6 for A1: the receiver's authorization cannot submit a payment that
/// debits the sender; the sender's can.
#[test]
fn the_receiver_cannot_submit_a_payment_from_the_sender() {
    let s = Setup::funded(&[100, 0]);
    let c = s.client();
    let args: Vec<Val> = (s.bank(0).clone(), s.bank(1).clone(), 40_i128, N).into_val(&s.env);

    authorize(&s, s.bank(1), "submit", args.clone(), &[]);
    assert_eq!(host_error(&s, "submit", args.clone()), auth_failure());
    assert_eq!(s.balances(), std::vec![100, 0]);
    assert_eq!(c.payment(&0), None);

    authorize(&s, s.bank(0), "submit", args, &[]);
    c.submit(s.bank(0), s.bank(1), &40, &N);
    assert_eq!(s.balances(), std::vec![60, 40]);
}

// ---------------------------------------------------------------------------------------
// revoke (A6) and reprioritise (A8)

/// SC-A06-10. S6 for A6: the sender authorizes the revocation.
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

/// SC-A06-10. S6, S13 for A6: neither the receiver's authorization nor none at all can
/// revoke, and the payment stays queued; the sender's can. Under UntilSettlement the
/// receiver's consent is neither needed nor enough (ADR-0016).
#[test]
fn only_the_sender_can_revoke() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    let args: Vec<Val> = (id,).into_val(&s.env);

    authorize(&s, s.bank(1), "revoke", args.clone(), &[]);
    assert_eq!(host_error(&s, "revoke", args.clone()), auth_failure());
    s.env.set_auths(&[]);
    assert_eq!(host_error(&s, "revoke", args.clone()), auth_failure());
    assert_eq!(c.payment(&id).unwrap().status, Status::Queued);
    assert_eq!(c.queued_count(), 1);

    authorize(&s, s.bank(0), "revoke", args, &[]);
    c.revoke(&id);
    assert_eq!(c.payment(&id).unwrap().status, Status::Revoked);
}

/// SC-A08-08. S6 for A8: the sender authorizes the reprioritisation.
#[test]
fn reprioritise_is_authorized_by_the_sender() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    c.reprioritise(&id, &U);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.bank(0).clone(),
            call(
                e,
                &s.contract,
                "reprioritise",
                (id, U).into_val(e),
                std::vec![],
            )
        )]
    );
}

/// SC-A08-08. S6 for A8: neither the receiver's authorization nor none at all can
/// reprioritise, and nothing moves; the sender's can.
#[test]
fn only_the_sender_can_reprioritise() {
    let s = Setup::new(2, 0);
    let c = s.client();
    let id = c.submit(s.bank(0), s.bank(1), &60, &N);
    let args: Vec<Val> = (id, U).into_val(&s.env);

    authorize(&s, s.bank(1), "reprioritise", args.clone(), &[]);
    assert_eq!(host_error(&s, "reprioritise", args.clone()), auth_failure());
    s.env.set_auths(&[]);
    assert_eq!(host_error(&s, "reprioritise", args.clone()), auth_failure());
    assert_eq!(c.payment(&id).unwrap().priority, N);
    assert_eq!(s.queue(0, N), std::vec![id]);

    authorize(&s, s.bank(0), "reprioritise", args, &[]);
    c.reprioritise(&id, &U);
    assert_eq!(s.queue(0, U), std::vec![id]);
}

// ---------------------------------------------------------------------------------------
// expire (A5) and convert_overdue (ADR-0014): the system's own steps

/// SC-A05-09. S6 for A5: rejection is `sys`'s step, so any keeper may trigger it with no
/// authorization at all (ADR-0015; M1: attributed to `sys` whoever triggers it).
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

/// SC-A20-09. S6: converting an overdue repo is a system step (ADR-0014); any keeper may
/// trigger it with no authorization.
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

/// SC-A14-04. S6 for A14: the central bank authorizes `set_collateral`.
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

/// SC-A14-04. S6 for A14: neither the bank's authorization nor none at all can set the
/// bank's collateral; the central bank's can.
#[test]
fn only_the_central_bank_can_set_collateral() {
    let s = Setup::new(1, 0);
    let c = s.client();
    let args: Vec<Val> = (s.bank(0).clone(), 100_i128).into_val(&s.env);

    authorize(&s, s.bank(0), "set_collateral", args.clone(), &[]);
    assert_eq!(
        host_error(&s, "set_collateral", args.clone()),
        auth_failure()
    );
    s.env.set_auths(&[]);
    assert_eq!(
        host_error(&s, "set_collateral", args.clone()),
        auth_failure()
    );
    assert_eq!(c.credit(s.bank(0)).coll, 0);

    authorize(&s, &s.cb, "set_collateral", args, &[]);
    c.set_collateral(s.bank(0), &100);
    assert_eq!(c.credit(s.bank(0)).coll, 100);
}

/// SC-A12-07. S6 for A12, D1: the central bank authorizes the repo, and in the same tree
/// the SAC mint that issues the money into the contract (ADR-0011: the issuer mints).
/// The central bank's account is the SAC admin here, which is provisional (see `Setup`).
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

/// SC-A12-07. S6 for A12: neither the bank's authorization nor none at all can open a
/// repo, and nothing is minted; the central bank's tree with the mint can.
#[test]
fn only_the_central_bank_can_open_a_repo() {
    let s = Setup::new(1, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    let e = &s.env;
    let args: Vec<Val> = (s.bank(0).clone(), 60_i128).into_val(e);
    let mint = MockAuthInvoke {
        contract: &s.token,
        fn_name: "mint",
        args: (s.contract.clone(), 60_i128).into_val(e),
        sub_invokes: &[],
    };

    authorize(
        &s,
        s.bank(0),
        "open_repo",
        args.clone(),
        core::slice::from_ref(&mint),
    );
    assert_eq!(host_error(&s, "open_repo", args.clone()), auth_failure());
    s.env.set_auths(&[]);
    assert_eq!(host_error(&s, "open_repo", args.clone()), auth_failure());
    assert_eq!(s.token().balance(&s.contract), 0);
    assert_eq!(c.balance(s.bank(0)), 0);
    assert_eq!(c.credit(s.bank(0)).cr, 0);
    assert_eq!(c.repo(&0), None);

    authorize(&s, &s.cb, "open_repo", args, &[mint]);
    c.open_repo(s.bank(0), &60);
    assert_eq!(c.balance(s.bank(0)), 60);
}

/// SC-A13-09. S6 for A13: the repaying bank authorizes `repay` alone; the contract burns
/// its own tokens as the direct caller, so the burn needs no one else's authorization.
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

/// SC-A13-09. S6 for A13 with the central bank as the actor: it authorizes `repay`
/// alone, and the bank authorizes nothing.
#[test]
fn repay_by_the_central_bank_is_authorized_by_the_central_bank_alone() {
    let s = Setup::new(1, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    let id = c.open_repo(s.bank(0), &60);
    c.repay(&s.cb, &id, &20);
    let e = &s.env;
    assert_eq!(
        e.auths(),
        std::vec![(
            s.cb.clone(),
            call(
                e,
                &s.contract,
                "repay",
                (s.cb.clone(), id, 20_i128).into_val(e),
                std::vec![],
            )
        )]
    );
}

/// SC-A13-09. S6 for A13: naming the bank, or the central bank, as the actor without that
/// actor's authorization fails, and nothing is burned; with the actor's tree it succeeds.
#[test]
fn repay_without_the_actors_authorization_fails() {
    let s = Setup::new(1, 0);
    let c = s.client();
    c.set_collateral(s.bank(0), &100);
    let id = c.open_repo(s.bank(0), &60);
    s.env.set_auths(&[]);
    let by_bank: Vec<Val> = (s.bank(0).clone(), id, 20_i128).into_val(&s.env);
    let by_cb: Vec<Val> = (s.cb.clone(), id, 20_i128).into_val(&s.env);

    assert_eq!(host_error(&s, "repay", by_bank.clone()), auth_failure());
    authorize(&s, s.bank(0), "repay", by_cb.clone(), &[]);
    assert_eq!(host_error(&s, "repay", by_cb.clone()), auth_failure());
    assert_eq!(s.token().balance(&s.contract), 60);
    assert_eq!(c.balance(s.bank(0)), 60);
    assert_eq!(c.repo(&id).unwrap().outstanding, 60);

    authorize(&s, s.bank(0), "repay", by_bank, &[]);
    c.repay(s.bank(0), &id, &20);
    assert_eq!(c.repo(&id).unwrap().outstanding, 40);
}

/// SC-A13-04. S6: a third party that authorizes its own call is still refused by the
/// contract's rule, with `NotAuthorized`, and nothing changes.
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
    assert_eq!(c.repo(&id).unwrap().outstanding, 60);
    assert_eq!(c.balance(s.bank(0)), 60);
}
