//! Shared setup and the checks every test can make after a call.
use std::vec::Vec as StdVec;

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    xdr, Address, Env, Event,
};

use crate::{Config, Priority, Settlement, SettlementArgs, SettlementClient};

/// The configuration tests use unless they need another: room for 16 queued payments,
/// a one-day expiry (ADR-0015) and a one-day repo term with a 5% penalty rate (ADR-0014).
pub fn default_config() -> Config {
    Config {
        queue_cap: 16,
        expiry_secs: 86_400,
        repo_term_secs: 86_400,
        penalty_rate_bps: 500,
    }
}

/// A cash token (a SAC whose issuer, and so admin, is the central bank), the settlement
/// contract and `n` banks that each hold `funding` cash tokens outside the contract.
pub struct Setup {
    pub env: Env,
    pub cb: Address,
    pub token: Address,
    pub contract: Address,
    pub banks: StdVec<Address>,
}

impl Setup {
    /// Mocks every authorization, for tests of behaviour. Auth tests use [`Setup::strict`].
    pub fn new(n: usize, funding: i128) -> Self {
        Self::with_config(n, funding, default_config())
    }

    pub fn with_config(n: usize, funding: i128, config: Config) -> Self {
        let s = Self::strict_with_config(n, funding, config);
        s.env.mock_all_auths();
        s
    }

    /// Mocks no authorization: each test decides which auths the call under test gets.
    pub fn strict(n: usize, funding: i128) -> Self {
        Self::strict_with_config(n, funding, default_config())
    }

    fn strict_with_config(n: usize, funding: i128, config: Config) -> Self {
        let env = Env::default();
        let cb = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(cb.clone()).address();
        let contract = env.register(
            Settlement,
            SettlementArgs::__constructor(&token, &cb, &config),
        );
        let banks: StdVec<Address> = (0..n).map(|_| Address::generate(&env)).collect();
        env.mock_all_auths();
        for b in &banks {
            if funding > 0 {
                StellarAssetClient::new(&env, &token).mint(b, &funding);
            }
        }
        env.set_auths(&[]);
        Setup {
            env,
            cb,
            token,
            contract,
            banks,
        }
    }

    /// `n` banks whose settlement balances are `balances[i]`, deposited and nothing else.
    pub fn funded(balances: &[i128]) -> Self {
        let s = Self::new(balances.len(), 0);
        for (b, amount) in s.banks.iter().zip(balances) {
            if *amount > 0 {
                s.mint(b, *amount);
                s.client().deposit(b, amount);
            }
        }
        s
    }

    pub fn client(&self) -> SettlementClient<'_> {
        SettlementClient::new(&self.env, &self.contract)
    }

    pub fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }

    pub fn bank(&self, i: usize) -> &Address {
        &self.banks[i]
    }

    /// Mints cash tokens to `to` outside the contract, with the issuer's authorization.
    pub fn mint(&self, to: &Address, amount: i128) {
        StellarAssetClient::new(&self.env, &self.token)
            .mock_all_auths()
            .mint(to, &amount);
    }

    /// Every bank's settlement balance, in bank order.
    pub fn balances(&self) -> StdVec<i128> {
        let c = self.client();
        self.banks.iter().map(|b| c.balance(b)).collect()
    }

    /// S1, conservation (ADR-0004): the cash tokens the contract holds equal the sum of
    /// the settlement balances it records, and no balance is negative (S2, with no credit
    /// line under ADR-0011).
    pub fn assert_conserved(&self) {
        let balances = self.balances();
        assert!(balances.iter().all(|b| *b >= 0), "negative: {balances:?}");
        let sum: i128 = balances.iter().sum();
        assert_eq!(
            self.token().balance(&self.contract),
            sum,
            "S1: {balances:?}"
        );
    }

    /// The ids `bank(i)` has queued at `priority`, head first, as a std vector.
    pub fn queue(&self, i: usize, priority: Priority) -> StdVec<u64> {
        self.client()
            .queue(self.bank(i), &priority)
            .iter()
            .collect()
    }

    /// A19 `Tick`: sets the ledger's close time.
    pub fn at(&self, timestamp: u64) {
        self.env.ledger().set_timestamp(timestamp);
    }

    /// One of our events as the XDR the host records, to compare with [`Setup::our_events`].
    pub fn ev(&self, event: impl Event) -> xdr::ContractEvent {
        event.to_xdr(&self.env, &self.contract)
    }

    /// The events this contract published in the last top-level invocation (C-HB-132).
    /// Call it right after the call under test.
    pub fn our_events(&self) -> StdVec<xdr::ContractEvent> {
        let ours = Some(contract_id(&self.contract));
        self.env
            .events()
            .all()
            .events()
            .iter()
            .filter(|e| e.contract_id == ours)
            .cloned()
            .collect()
    }
}

/// The XDR contract id of a contract address, for filtering `xdr::ContractEvent`s.
pub fn contract_id(address: &Address) -> xdr::ContractId {
    match xdr::ScAddress::from(address) {
        xdr::ScAddress::Contract(id) => id,
        other => panic!("not a contract address: {other:?}"),
    }
}
