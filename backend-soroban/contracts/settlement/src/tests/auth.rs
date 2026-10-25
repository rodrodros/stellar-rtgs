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

const NORMAL: Priority = Priority::Normal;
const URGENT: Priority = Priority::Urgent;

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
fn host_error(setup: &Setup, function: &str, args: Vec<Val>) -> soroban_sdk::Error {
    match setup.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &setup.contract,
        &Symbol::new(&setup.env, function),
        args,
    ) {
        Err(Ok(error)) => error,
        other => panic!("{function} should fail with a host error, got {other:?}"),
    }
}

/// Mocks exactly one authorization: `who` signs `function(args)` on the contract, with
/// `sub_invokes` beneath it. Nothing else is authorized.
fn authorize(
    setup: &Setup,
    who: &Address,
    function: &str,
    args: Vec<Val>,
    sub_invokes: &[MockAuthInvoke],
) {
    setup.env.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke {
            contract: &setup.contract,
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
    let setup = Setup::new(1, 1_000);
    setup.client().deposit(setup.bank(0), &600);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.bank(0).clone(),
            call(
                env,
                &setup.contract,
                "deposit",
                (setup.bank(0).clone(), 600_i128).into_val(env),
                std::vec![call(
                    env,
                    &setup.token,
                    "transfer",
                    (setup.bank(0).clone(), setup.contract.clone(), 600_i128).into_val(env),
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
    let setup = Setup::strict(1, 1_000);
    let env = &setup.env;
    let args: Vec<Val> = (setup.bank(0).clone(), 600_i128).into_val(env);

    assert_eq!(host_error(&setup, "deposit", args.clone()), auth_failure());
    assert_eq!(setup.token().balance(setup.bank(0)), 1_000);
    assert_eq!(setup.token().balance(&setup.contract), 0);
    assert_eq!(setup.client().balance(setup.bank(0)), 0);

    let transfer = MockAuthInvoke {
        contract: &setup.token,
        fn_name: "transfer",
        args: (setup.bank(0).clone(), setup.contract.clone(), 600_i128).into_val(env),
        sub_invokes: &[],
    };
    authorize(&setup, setup.bank(0), "deposit", args, &[transfer]);
    setup.client().deposit(setup.bank(0), &600);
    assert_eq!(setup.client().balance(setup.bank(0)), 600);
}

/// SC-A11-12. S6 for A11: the bank authorizes `withdraw` alone; the contract authorizes
/// its own transfer out as the direct caller (C-SC-074).
#[test]
fn withdraw_is_authorized_by_the_bank_alone() {
    let setup = Setup::funded(&[1_000]);
    setup.client().withdraw(setup.bank(0), &300);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.bank(0).clone(),
            call(
                env,
                &setup.contract,
                "withdraw",
                (setup.bank(0).clone(), 300_i128).into_val(env),
                std::vec![],
            )
        )]
    );
}

/// SC-A11-12. S6 for A11: without the bank's authorization the withdrawal fails and
/// nothing moves; with exactly the bank's tree it succeeds.
#[test]
fn withdraw_without_the_banks_authorization_fails() {
    let setup = Setup::funded(&[1_000]);
    setup.env.set_auths(&[]);
    let client = setup.client();
    let args: Vec<Val> = (setup.bank(0).clone(), 300_i128).into_val(&setup.env);

    assert_eq!(host_error(&setup, "withdraw", args.clone()), auth_failure());
    assert_eq!(client.balance(setup.bank(0)), 1_000);
    assert_eq!(setup.token().balance(&setup.contract), 1_000);

    authorize(&setup, setup.bank(0), "withdraw", args, &[]);
    client.withdraw(setup.bank(0), &300);
    assert_eq!(client.balance(setup.bank(0)), 700);
}

// ---------------------------------------------------------------------------------------
// submit (A1)

/// SC-A01-16. S6 for A1: `mayDebit` holds only `(owner(a), a)`, so the sender authorizes
/// the submission, and nothing else, even when the payment settles at once.
#[test]
fn submit_is_authorized_by_the_sender_alone() {
    let setup = Setup::funded(&[100, 0]);
    setup
        .client()
        .submit(setup.bank(0), setup.bank(1), &40, &NORMAL);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.bank(0).clone(),
            call(
                env,
                &setup.contract,
                "submit",
                (
                    setup.bank(0).clone(),
                    setup.bank(1).clone(),
                    40_i128,
                    NORMAL
                )
                    .into_val(env),
                std::vec![],
            )
        )]
    );
}

/// SC-A01-16. S6 for A1: with no authorization the submission fails, nothing settles and
/// nothing is queued; with exactly the sender's tree it settles.
#[test]
fn submit_without_the_senders_authorization_fails() {
    let setup = Setup::funded(&[100, 0]);
    setup.env.set_auths(&[]);
    let client = setup.client();
    let args: Vec<Val> = (
        setup.bank(0).clone(),
        setup.bank(1).clone(),
        40_i128,
        NORMAL,
    )
        .into_val(&setup.env);

    assert_eq!(host_error(&setup, "submit", args.clone()), auth_failure());
    assert_eq!(setup.balances(), std::vec![100, 0]);
    assert_eq!(client.queued_count(), 0);
    assert_eq!(client.payment(&0), None);

    authorize(&setup, setup.bank(0), "submit", args, &[]);
    client.submit(setup.bank(0), setup.bank(1), &40, &NORMAL);
    assert_eq!(setup.balances(), std::vec![60, 40]);
}

/// SC-A01-16. S6 for A1: the receiver's authorization cannot submit a payment that
/// debits the sender; the sender's can.
#[test]
fn the_receiver_cannot_submit_a_payment_from_the_sender() {
    let setup = Setup::funded(&[100, 0]);
    let client = setup.client();
    let args: Vec<Val> = (
        setup.bank(0).clone(),
        setup.bank(1).clone(),
        40_i128,
        NORMAL,
    )
        .into_val(&setup.env);

    authorize(&setup, setup.bank(1), "submit", args.clone(), &[]);
    assert_eq!(host_error(&setup, "submit", args.clone()), auth_failure());
    assert_eq!(setup.balances(), std::vec![100, 0]);
    assert_eq!(client.payment(&0), None);

    authorize(&setup, setup.bank(0), "submit", args, &[]);
    client.submit(setup.bank(0), setup.bank(1), &40, &NORMAL);
    assert_eq!(setup.balances(), std::vec![60, 40]);
}

// ---------------------------------------------------------------------------------------
// revoke (A6) and reprioritise (A8)

/// SC-A06-10. S6 for A6: the sender authorizes the revocation.
#[test]
fn revoke_is_authorized_by_the_sender() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    client.revoke(&id);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.bank(0).clone(),
            call(
                env,
                &setup.contract,
                "revoke",
                (id,).into_val(env),
                std::vec![]
            )
        )]
    );
}

/// SC-A06-10. S6, S13 for A6: neither the receiver's authorization nor none at all can
/// revoke, and the payment stays queued; the sender's can. Under UntilSettlement the
/// receiver's consent is neither needed nor enough (ADR-0016).
#[test]
fn only_the_sender_can_revoke() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    let args: Vec<Val> = (id,).into_val(&setup.env);

    authorize(&setup, setup.bank(1), "revoke", args.clone(), &[]);
    assert_eq!(host_error(&setup, "revoke", args.clone()), auth_failure());
    setup.env.set_auths(&[]);
    assert_eq!(host_error(&setup, "revoke", args.clone()), auth_failure());
    assert_eq!(client.payment(&id).unwrap().status, Status::Queued);
    assert_eq!(client.queued_count(), 1);

    authorize(&setup, setup.bank(0), "revoke", args, &[]);
    client.revoke(&id);
    assert_eq!(client.payment(&id).unwrap().status, Status::Revoked);
}

/// SC-A08-08. S6 for A8: the sender authorizes the reprioritisation.
#[test]
fn reprioritise_is_authorized_by_the_sender() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    client.reprioritise(&id, &URGENT);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.bank(0).clone(),
            call(
                env,
                &setup.contract,
                "reprioritise",
                (id, URGENT).into_val(env),
                std::vec![],
            )
        )]
    );
}

/// SC-A08-08. S6 for A8: neither the receiver's authorization nor none at all can
/// reprioritise, and nothing moves; the sender's can.
#[test]
fn only_the_sender_can_reprioritise() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    let args: Vec<Val> = (id, URGENT).into_val(&setup.env);

    authorize(&setup, setup.bank(1), "reprioritise", args.clone(), &[]);
    assert_eq!(
        host_error(&setup, "reprioritise", args.clone()),
        auth_failure()
    );
    setup.env.set_auths(&[]);
    assert_eq!(
        host_error(&setup, "reprioritise", args.clone()),
        auth_failure()
    );
    assert_eq!(client.payment(&id).unwrap().priority, NORMAL);
    assert_eq!(setup.queue(0, NORMAL), std::vec![id]);

    authorize(&setup, setup.bank(0), "reprioritise", args, &[]);
    client.reprioritise(&id, &URGENT);
    assert_eq!(setup.queue(0, URGENT), std::vec![id]);
}

// ---------------------------------------------------------------------------------------
// expire (A5) and convert_overdue (ADR-0014): the system's own steps

/// SC-A05-09. S6 for A5: rejection is `sys`'s step, so any keeper may trigger it with no
/// authorization at all (ADR-0015; M1: attributed to `sys` whoever triggers it).
#[test]
fn expire_needs_no_authorization() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    let id = client.submit(setup.bank(0), setup.bank(1), &60, &NORMAL);
    setup.env.set_auths(&[]);
    setup.at(default_config().expiry_secs + 1);

    client.expire(&id);

    assert!(setup.env.auths().is_empty());
    assert_eq!(client.payment(&id).unwrap().status, Status::Expired);
}

/// SC-A20-09. S6: converting an overdue repo is a system step (ADR-0014); any keeper may
/// trigger it with no authorization.
#[test]
fn convert_overdue_needs_no_authorization() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    setup.env.set_auths(&[]);
    setup.at(default_config().repo_term_secs + 1);

    client.convert_overdue(&id);

    assert!(setup.env.auths().is_empty());
    assert_eq!(client.repo(&id).unwrap().status, RepoStatus::Penalty);
}

// ---------------------------------------------------------------------------------------
// set_collateral (A14), open_repo (A12), repay (A13, A20)

/// SC-A14-04. S6 for A14: the central bank authorizes `set_collateral`.
#[test]
fn set_collateral_is_authorized_by_the_central_bank() {
    let setup = Setup::new(1, 0);
    setup.client().set_collateral(setup.bank(0), &100);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.cb.clone(),
            call(
                env,
                &setup.contract,
                "set_collateral",
                (setup.bank(0).clone(), 100_i128).into_val(env),
                std::vec![],
            )
        )]
    );
}

/// SC-A14-04. S6 for A14: neither the bank's authorization nor none at all can set the
/// bank's collateral; the central bank's can.
#[test]
fn only_the_central_bank_can_set_collateral() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    let args: Vec<Val> = (setup.bank(0).clone(), 100_i128).into_val(&setup.env);

    authorize(&setup, setup.bank(0), "set_collateral", args.clone(), &[]);
    assert_eq!(
        host_error(&setup, "set_collateral", args.clone()),
        auth_failure()
    );
    setup.env.set_auths(&[]);
    assert_eq!(
        host_error(&setup, "set_collateral", args.clone()),
        auth_failure()
    );
    assert_eq!(client.credit(setup.bank(0)).coll, 0);

    authorize(&setup, &setup.cb, "set_collateral", args, &[]);
    client.set_collateral(setup.bank(0), &100);
    assert_eq!(client.credit(setup.bank(0)).coll, 100);
}

/// SC-A12-07. S6 for A12, D1: the central bank authorizes the repo, and in the same tree
/// the SAC mint that issues the money into the contract (ADR-0011: the issuer mints).
/// The central bank's account is the SAC admin here, which is provisional (see `Setup`).
#[test]
fn open_repo_is_authorized_by_the_central_bank_with_the_mint() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    client.open_repo(setup.bank(0), &60);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.cb.clone(),
            call(
                env,
                &setup.contract,
                "open_repo",
                (setup.bank(0).clone(), 60_i128).into_val(env),
                std::vec![call(
                    env,
                    &setup.token,
                    "mint",
                    (setup.contract.clone(), 60_i128).into_val(env),
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
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let env = &setup.env;
    let args: Vec<Val> = (setup.bank(0).clone(), 60_i128).into_val(env);
    let mint = MockAuthInvoke {
        contract: &setup.token,
        fn_name: "mint",
        args: (setup.contract.clone(), 60_i128).into_val(env),
        sub_invokes: &[],
    };

    authorize(
        &setup,
        setup.bank(0),
        "open_repo",
        args.clone(),
        core::slice::from_ref(&mint),
    );
    assert_eq!(
        host_error(&setup, "open_repo", args.clone()),
        auth_failure()
    );
    setup.env.set_auths(&[]);
    assert_eq!(
        host_error(&setup, "open_repo", args.clone()),
        auth_failure()
    );
    assert_eq!(setup.token().balance(&setup.contract), 0);
    assert_eq!(client.balance(setup.bank(0)), 0);
    assert_eq!(client.credit(setup.bank(0)).cr, 0);
    assert_eq!(client.repo(&0), None);

    authorize(&setup, &setup.cb, "open_repo", args, &[mint]);
    client.open_repo(setup.bank(0), &60);
    assert_eq!(client.balance(setup.bank(0)), 60);
}

/// SC-A13-09. S6 for A13: the repaying bank authorizes `repay` alone; the contract burns
/// its own tokens as the direct caller, so the burn needs no one else's authorization.
#[test]
fn repay_is_authorized_by_the_actor_alone() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    client.repay(setup.bank(0), &id, &20);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.bank(0).clone(),
            call(
                env,
                &setup.contract,
                "repay",
                (setup.bank(0).clone(), id, 20_i128).into_val(env),
                std::vec![],
            )
        )]
    );
}

/// SC-A13-09. S6 for A13 with the central bank as the actor: it authorizes `repay`
/// alone, and the bank authorizes nothing.
#[test]
fn repay_by_the_central_bank_is_authorized_by_the_central_bank_alone() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    client.repay(&setup.cb, &id, &20);
    let env = &setup.env;
    assert_eq!(
        env.auths(),
        std::vec![(
            setup.cb.clone(),
            call(
                env,
                &setup.contract,
                "repay",
                (setup.cb.clone(), id, 20_i128).into_val(env),
                std::vec![],
            )
        )]
    );
}

/// SC-A13-09. S6 for A13: naming the bank, or the central bank, as the actor without that
/// actor's authorization fails, and nothing is burned; with the actor's tree it succeeds.
#[test]
fn repay_without_the_actors_authorization_fails() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    setup.env.set_auths(&[]);
    let by_bank: Vec<Val> = (setup.bank(0).clone(), id, 20_i128).into_val(&setup.env);
    let by_cb: Vec<Val> = (setup.cb.clone(), id, 20_i128).into_val(&setup.env);

    assert_eq!(host_error(&setup, "repay", by_bank.clone()), auth_failure());
    authorize(&setup, setup.bank(0), "repay", by_cb.clone(), &[]);
    assert_eq!(host_error(&setup, "repay", by_cb.clone()), auth_failure());
    assert_eq!(setup.token().balance(&setup.contract), 60);
    assert_eq!(client.balance(setup.bank(0)), 60);
    assert_eq!(client.repo(&id).unwrap().outstanding, 60);

    authorize(&setup, setup.bank(0), "repay", by_bank, &[]);
    client.repay(setup.bank(0), &id, &20);
    assert_eq!(client.repo(&id).unwrap().outstanding, 40);
}

/// SC-A13-04. S6: a third party that authorizes its own call is still refused by the
/// contract's rule, with `NotAuthorized`, and nothing changes.
#[test]
fn an_authorized_third_party_is_still_not_authorized_to_repay() {
    let setup = Setup::new(2, 0);
    let client = setup.client();
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);
    assert_eq!(
        client.try_repay(setup.bank(1), &id, &20),
        Err(Ok(Error::NotAuthorized))
    );
    assert_eq!(client.repo(&id).unwrap().outstanding, 60);
    assert_eq!(client.balance(setup.bank(0)), 60);
}
