//! Unit tests on the soroban-sdk test host. This file is the template for new unit tests:
//! see TESTING.md, "Unit and auth tests".
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _},
    token::{StellarAssetClient, TokenClient},
    Event, IntoVal, Symbol,
};

/// A cash token (a test issuer's SAC), the settlement contract, and one funded bank.
struct Setup {
    env: Env,
    token: Address,
    contract: Address,
    bank: Address,
}

impl Setup {
    fn new(funding: i128) -> Self {
        let env = Env::default();
        let issuer = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(issuer).address();
        let contract = env.register(Settlement, SettlementArgs::__constructor(&token));
        let bank = Address::generate(&env);
        // Mock only the issuer's mint; each test decides which auths the call under test gets.
        env.mock_all_auths();
        StellarAssetClient::new(&env, &token).mint(&bank, &funding);
        env.set_auths(&[]);
        Setup {
            env,
            token,
            contract,
            bank,
        }
    }

    fn client(&self) -> SettlementClient<'_> {
        SettlementClient::new(&self.env, &self.contract)
    }

    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }
}

/// A deposit moves cash tokens into the contract and credits the bank's settlement
/// balance by the same amount, so the tokens the contract holds equal the sum of the
/// balances it records (S1, conservation).
#[test]
fn deposit_moves_tokens_into_the_contract_and_credits_the_bank() {
    let s = Setup::new(1_000);
    let c = s.client();
    s.env.mock_all_auths();

    c.deposit(&s.bank, &600);

    // The bank authorized one tree: `deposit`, with the token transfer it makes on the
    // bank's behalf. `mock_all_auths` alone would pass a missing `require_auth` (C-HB-130).
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.bank.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.contract.clone(),
                    Symbol::new(&s.env, "deposit"),
                    (s.bank.clone(), 600_i128).into_val(&s.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        s.token.clone(),
                        Symbol::new(&s.env, "transfer"),
                        (s.bank.clone(), s.contract.clone(), 600_i128).into_val(&s.env),
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        )]
    );
    // Events cover the last top-level invocation only (C-HB-132): the SAC's transfer
    // event, then ours.
    let events = s.env.events().all();
    assert_eq!(events.events().len(), 2);
    assert_eq!(
        events.events()[1],
        Deposited {
            bank: s.bank.clone(),
            amount: 600,
        }
        .to_xdr(&s.env, &s.contract)
    );

    assert_eq!(s.token().balance(&s.bank), 400);
    assert_eq!(s.token().balance(&s.contract), 600);
    assert_eq!(c.balance(&s.bank), 600);
    // S1: the only bank's balance is the whole of what the contract holds.
    assert_eq!(s.token().balance(&s.contract), c.balance(&s.bank));
}

/// Without the bank's authorization the deposit fails and nothing moves.
#[test]
fn deposit_without_the_banks_authorization_fails() {
    let s = Setup::new(1_000);
    let c = s.client();

    assert!(c.try_deposit(&s.bank, &600).is_err());

    assert_eq!(s.token().balance(&s.bank), 1_000);
    assert_eq!(s.token().balance(&s.contract), 0);
}
