//! State-machine test: proptest-state-machine drives random call sequences through a
//! reference model and the contract, and compares the outcome and the whole state after
//! every call (TESTING.md, "Property and state-machine tests").
//!
//! The model is §4 under κ-proto as the ADRs amend it, written as plain Rust:
//! - one account per bank, no credit line, reservations or limits (ADR-0011, ADR-0018);
//! - two priorities, each strict FIFO by sequence number; reprioritising keeps the
//!   number (A8 with toEnd = false; ADR-0008, ADR-0009);
//! - after every call that can add liquidity or unblock a queue, the eager closure
//!   settles exactly S(k*): by R6 any interleaving of FIFO gross steps (A2) and
//!   greatest-prefix offsets (A3) ends there (S9, S23; ADR-0010);
//! - no business day: no A17 `Open`, no A18 `Close`, no value dates and no τ_rc or τ_qc.
//!   A queued payment expires `expiry_secs` after submission (A5, ADR-0013, ADR-0015);
//!   revocation has no cut-off (A6, ADR-0016); a repo past its term becomes a penalty repo,
//!   still collateralised, in place of A18's overnight credit (A20, ADR-0014).
//! - expiry follows `quint/settlement.qnt`, which the replay (SC-MB-01) already pins: only
//!   `expire` (A5) expires a payment. A payment past its expiry stays queued, blocks its
//!   queue and can still settle or be revoked until someone calls `expire`, and the at-rest
//!   check (S23) counts it as a candidate. ADR-0015 lets a call that meets an expired head
//!   reject it, and S12's τ_rej would forbid settling it. Whether v1 should do either is
//!   still open (README, "Decide whether an expired payment can still settle"); if it
//!   should, change this model's `settle` and `expire`, SC-P-01 and `settlement.qnt`
//!   together.
//!
//! Where an input breaks several guards at once, the model fixes the order of the errors:
//! unknown id, then final status, then the specific guard. For `repay`: `UnknownRepo`,
//! `NotAuthorized`, `RepayExceedsRepo`, `InsufficientFunds`; for `reprioritise`:
//! `UnknownPayment`, `NotQueued`, `SamePriority`; for `expire`: `UnknownPayment`,
//! `NotQueued`, `NotExpired`. The unit tests leave that order open; `quint/settlement.qnt`
//! (SC-MB-01) already fixes it for `reprioritise` and `expire`, so `repay`'s is new here.
use std::collections::BTreeMap;
use std::vec;
use std::vec::Vec;

use proptest::prelude::*;
use proptest_state_machine::{prop_state_machine, ReferenceStateMachine, StateMachineTest};

use super::reference::{config, greatest_feasible_prefix};
use super::support::Setup;
use crate::{Config, Credit, Error, Payment, Priority, Repo, RepoStatus, Status};

const BANKS: usize = 3;
const FUNDING: i128 = 500;
/// The central bank, as an actor index next to the banks.
const CB: usize = BANKS;

/// A queue cap no run reaches, so the cap's rule (which the property tests SC-P-01 and
/// SC-P-11 and the unit tests cover) stays out of the comparison; short expiry and repo
/// terms that `Tick` reaches.
fn test_config() -> Config {
    Config {
        queue_cap: 1_000,
        expiry_secs: 100,
        repo_term_secs: 100,
        penalty_rate_bps: 500,
    }
}

#[derive(Clone, Debug)]
pub struct ModelPayment {
    from: usize,
    to: usize,
    amount: i128,
    priority: Priority,
    submitted_at: u64,
    status: Status,
    settled_at: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct ModelRepo {
    bank: usize,
    amount: i128,
    outstanding: i128,
    opened_at: u64,
    status: RepoStatus,
    rate_bps: u32,
}

/// The reference model's state (§4.2–§4.4).
#[derive(Clone, Debug)]
pub struct Model {
    cfg: Config,
    /// Cash tokens each bank holds outside the contract.
    holding: [i128; BANKS],
    /// `bal`.
    balances: [i128; BANKS],
    /// `ord`, keyed by sequence number `q`.
    payments: BTreeMap<u64, ModelPayment>,
    next_id: u64,
    /// `coll`.
    coll: [i128; BANKS],
    repos: Vec<ModelRepo>,
    /// A19: the ledger's close time.
    now: u64,
    /// The outcome of the last call: its success value or its error.
    last: Result<i128, Error>,
}

impl Model {
    /// `bank`'s queued payments in `≺` order (§4.5): urgent before normal, then by id.
    fn candidates(&self, bank: usize) -> Vec<u64> {
        let mut ids: Vec<(bool, u64)> = self
            .payments
            .iter()
            .filter(|(_, payment)| payment.status == Status::Queued && payment.from == bank)
            .map(|(id, payment)| (payment.priority != Priority::Urgent, *id))
            .collect();
        ids.sort();
        ids.into_iter().map(|(_, id)| id).collect()
    }

    fn queue(&self, bank: usize, priority: Priority) -> Vec<u64> {
        self.candidates(bank)
            .into_iter()
            .filter(|id| self.payments[id].priority == priority)
            .collect()
    }

    /// The eager closure: settle S(k*) (R6, S9, S23).
    fn settle(&mut self) {
        let candidates: Vec<Vec<u64>> = (0..BANKS).map(|bank| self.candidates(bank)).collect();
        let queues: Vec<Vec<(usize, i128)>> = candidates
            .iter()
            .map(|ids| {
                ids.iter()
                    .map(|id| (self.payments[id].to, self.payments[id].amount))
                    .collect()
            })
            .collect();
        let prefix = greatest_feasible_prefix(&self.balances, &queues);
        for (bank, ids) in candidates.iter().enumerate() {
            for id in &ids[..prefix[bank]] {
                let payment = self.payments.get_mut(id).unwrap();
                payment.status = Status::Settled;
                payment.settled_at = Some(self.now);
                self.balances[payment.from] -= payment.amount;
                self.balances[payment.to] += payment.amount;
            }
        }
    }

    /// `cr` and `ovn` of `bank`: its outstanding intraday and penalty repos.
    fn credit(&self, bank: usize) -> Credit {
        let sum = |status| {
            self.repos
                .iter()
                .filter(|repo| repo.bank == bank && repo.status == status)
                .map(|repo| repo.outstanding)
                .sum()
        };
        Credit {
            cr: sum(RepoStatus::Intraday),
            ovn: sum(RepoStatus::Penalty),
            coll: self.coll[bank],
        }
    }

    fn queued(&self, id: u64) -> Result<&ModelPayment, Error> {
        let payment = self.payments.get(&id).ok_or(Error::UnknownPayment)?;
        if payment.status != Status::Queued {
            return Err(Error::NotQueued);
        }
        Ok(payment)
    }
}

#[derive(Clone, Debug)]
pub enum Transition {
    Deposit {
        bank: usize,
        amount: i128,
    },
    Withdraw {
        bank: usize,
        amount: i128,
    },
    Submit {
        from: usize,
        to: usize,
        amount: i128,
        priority: Priority,
    },
    Revoke {
        id: u64,
    },
    Reprioritise {
        id: u64,
        priority: Priority,
    },
    Expire {
        id: u64,
    },
    Tick {
        secs: u64,
    },
    SetCollateral {
        bank: usize,
        value: i128,
    },
    OpenRepo {
        bank: usize,
        amount: i128,
    },
    Repay {
        actor: usize,
        repo: u64,
        amount: i128,
    },
    ConvertOverdue {
        repo: u64,
    },
}

pub struct Reference;

impl ReferenceStateMachine for Reference {
    type State = Model;
    type Transition = Transition;

    fn init_state() -> BoxedStrategy<Model> {
        Just(Model {
            cfg: test_config(),
            holding: [FUNDING; BANKS],
            balances: [0; BANKS],
            payments: BTreeMap::new(),
            next_id: 0,
            coll: [0; BANKS],
            repos: Vec::new(),
            now: 0,
            last: Ok(0),
        })
        .boxed()
    }

    fn transitions(state: &Model) -> BoxedStrategy<Transition> {
        // Mostly ids that are queued, sometimes final or unknown ones.
        let queued: Vec<u64> = state
            .payments
            .iter()
            .filter(|(_, payment)| payment.status == Status::Queued)
            .map(|(id, _)| *id)
            .collect();
        let any_id = (0..state.next_id + 2).boxed();
        let id = if queued.is_empty() {
            any_id
        } else {
            prop_oneof![3 => prop::sample::select(queued), 1 => any_id].boxed()
        };
        let repo = (0..state.repos.len() as u64 + 2).boxed();
        let amount = || 1i128..=300;
        let priority = || prop_oneof![Just(Priority::Normal), Just(Priority::Urgent)];
        // Random inputs rarely hit a boundary or reach the credit and expiry paths, so these
        // are drawn on purpose: the exact holding, balance, collateral headroom and
        // outstanding amount, one over the holding, the balance and the headroom, and the
        // payments and repos past their expiry or term.
        let (holding, balances) = (state.holding, state.balances);
        let outstanding: Vec<(u64, usize, i128)> = state
            .repos
            .iter()
            .enumerate()
            .filter(|(_, repo)| repo.outstanding > 0)
            .map(|(i, repo)| (i as u64, repo.bank, repo.outstanding))
            .collect();
        // With no case to draw from, each one falls back to the call that brings it into
        // reach: collateral for a repo, a repo for a repayment, time for the expiry and term.
        let collateral = || {
            (0..BANKS, 1i128..=400)
                .prop_map(|(bank, value)| Transition::SetCollateral { bank, value })
                .boxed()
        };
        let past = || Just(Transition::Tick { secs: 101 }).boxed();
        let exact_repay = pick(outstanding, collateral(), |(repo, bank, amount)| {
            Transition::Repay {
                actor: bank,
                repo,
                amount,
            }
        });
        let headroom: Vec<(usize, i128)> = (0..BANKS)
            .map(|bank| {
                let credit = state.credit(bank);
                (bank, credit.coll - credit.cr - credit.ovn)
            })
            .filter(|(_, available)| *available > 0)
            .collect();
        let exact_repo = pick(headroom.clone(), collateral(), |(bank, amount)| {
            Transition::OpenRepo { bank, amount }
        });
        let over_repo = pick(headroom, collateral(), |(bank, amount)| {
            Transition::OpenRepo {
                bank,
                amount: amount + 1,
            }
        });
        let past_expiry: Vec<u64> = state
            .payments
            .iter()
            .filter(|(_, payment)| payment.status == Status::Queued)
            .filter(|(_, payment)| state.now > payment.submitted_at + state.cfg.expiry_secs)
            .map(|(id, _)| *id)
            .collect();
        let due_expire = pick(past_expiry, past(), |id| Transition::Expire { id });
        let past_term: Vec<u64> = state
            .repos
            .iter()
            .enumerate()
            .filter(|(_, repo)| repo.status == RepoStatus::Intraday)
            .filter(|(_, repo)| state.now > repo.opened_at + state.cfg.repo_term_secs)
            .map(|(i, _)| i as u64)
            .collect();
        let due_convert = pick(past_term, past(), |repo| Transition::ConvertOverdue {
            repo,
        });
        prop_oneof![
            3 => (0..BANKS, amount()).prop_map(|(bank, amount)| Transition::Deposit { bank, amount }),
            1 => (0..BANKS).prop_map(move |bank| Transition::Deposit { bank, amount: holding[bank].max(1) }),
            1 => (0..BANKS).prop_map(move |bank| Transition::Deposit { bank, amount: holding[bank] + 1 }),
            1 => (0..BANKS, amount()).prop_map(|(bank, amount)| Transition::Withdraw { bank, amount }),
            1 => (0..BANKS).prop_map(move |bank| Transition::Withdraw { bank, amount: balances[bank].max(1) }),
            1 => (0..BANKS).prop_map(move |bank| Transition::Withdraw { bank, amount: balances[bank] + 1 }),
            6 => (0..BANKS, 0..BANKS, amount(), priority())
                .prop_map(|(from, to, amount, priority)| Transition::Submit { from, to, amount, priority }),
            2 => id.clone().prop_map(|id| Transition::Revoke { id }),
            2 => (id.clone(), priority()).prop_map(|(id, priority)| Transition::Reprioritise { id, priority }),
            1 => id.prop_map(|id| Transition::Expire { id }),
            2 => due_expire,
            2 => prop_oneof![Just(1u64), Just(100), Just(101), 0u64..=150]
                .prop_map(|secs| Transition::Tick { secs }),
            2 => (0..BANKS, 0i128..=400).prop_map(|(bank, value)| Transition::SetCollateral { bank, value }),
            1 => (0..BANKS, amount()).prop_map(|(bank, amount)| Transition::OpenRepo { bank, amount }),
            3 => exact_repo,
            1 => over_repo,
            1 => (0..=CB, repo.clone(), amount())
                .prop_map(|(actor, repo, amount)| Transition::Repay { actor, repo, amount }),
            2 => exact_repay,
            1 => repo.prop_map(|repo| Transition::ConvertOverdue { repo }),
            2 => due_convert,
        ]
        .boxed()
    }

    fn apply(mut state: Model, transition: &Transition) -> Model {
        state.last = match *transition {
            Transition::Deposit { bank, amount } => {
                if state.holding[bank] < amount {
                    Err(Error::TokenTransferFailed)
                } else {
                    state.holding[bank] -= amount;
                    state.balances[bank] += amount;
                    state.settle();
                    Ok(0)
                }
            }
            Transition::Withdraw { bank, amount } => {
                if state.balances[bank] < amount {
                    Err(Error::InsufficientFunds)
                } else {
                    // No reservations: a withdrawal may spend what a queued payment needs
                    // (ADR-0018), and it settles nothing.
                    state.balances[bank] -= amount;
                    state.holding[bank] += amount;
                    Ok(0)
                }
            }
            Transition::Submit {
                from,
                to,
                amount,
                priority,
            } => {
                if from == to {
                    Err(Error::SameAccount)
                } else {
                    let id = state.next_id;
                    state.next_id += 1;
                    state.payments.insert(
                        id,
                        ModelPayment {
                            from,
                            to,
                            amount,
                            priority,
                            submitted_at: state.now,
                            status: Status::Queued,
                            settled_at: None,
                        },
                    );
                    state.settle();
                    Ok(id.into())
                }
            }
            Transition::Revoke { id } => match state.queued(id) {
                Err(err) => Err(err),
                Ok(_) => {
                    state.payments.get_mut(&id).unwrap().status = Status::Revoked;
                    state.settle();
                    Ok(0)
                }
            },
            Transition::Reprioritise { id, priority } => match state.queued(id) {
                Err(err) => Err(err),
                Ok(payment) if payment.priority == priority => Err(Error::SamePriority),
                Ok(_) => {
                    state.payments.get_mut(&id).unwrap().priority = priority;
                    state.settle();
                    Ok(0)
                }
            },
            Transition::Expire { id } => match state.queued(id) {
                Err(err) => Err(err),
                Ok(payment) if state.now <= payment.submitted_at + state.cfg.expiry_secs => {
                    Err(Error::NotExpired)
                }
                Ok(_) => {
                    state.payments.get_mut(&id).unwrap().status = Status::Expired;
                    state.settle();
                    Ok(0)
                }
            },
            Transition::Tick { secs } => {
                // Time alone settles nothing: nothing is timed (ADR-0017).
                state.now += secs;
                Ok(0)
            }
            Transition::SetCollateral { bank, value } => {
                let credit = state.credit(bank);
                if value < credit.cr + credit.ovn {
                    Err(Error::CollateralBelowCredit)
                } else {
                    state.coll[bank] = value;
                    Ok(0)
                }
            }
            Transition::OpenRepo { bank, amount } => {
                let credit = state.credit(bank);
                if credit.cr + credit.ovn + amount > credit.coll {
                    Err(Error::CreditExceedsCollateral)
                } else {
                    state.repos.push(ModelRepo {
                        bank,
                        amount,
                        outstanding: amount,
                        opened_at: state.now,
                        status: RepoStatus::Intraday,
                        rate_bps: 0,
                    });
                    state.balances[bank] += amount;
                    state.settle();
                    Ok((state.repos.len() - 1) as i128)
                }
            }
            Transition::Repay {
                actor,
                repo,
                amount,
            } => match state.repos.get(repo as usize) {
                None => Err(Error::UnknownRepo),
                Some(record) if actor != record.bank && actor != CB => Err(Error::NotAuthorized),
                Some(record) if amount > record.outstanding => Err(Error::RepayExceedsRepo),
                Some(record) if state.balances[record.bank] < amount => {
                    Err(Error::InsufficientFunds)
                }
                Some(record) => {
                    let bank = record.bank;
                    let record = &mut state.repos[repo as usize];
                    record.outstanding -= amount;
                    if record.outstanding == 0 {
                        record.status = RepoStatus::Repaid;
                    }
                    state.balances[bank] -= amount;
                    Ok(0)
                }
            },
            Transition::ConvertOverdue { repo } => match state.repos.get(repo as usize) {
                None => Err(Error::UnknownRepo),
                Some(record) if record.status == RepoStatus::Repaid => Err(Error::NotOverdue),
                Some(record) if record.status == RepoStatus::Penalty => Err(Error::AlreadyPenalty),
                Some(record) if state.now <= record.opened_at + state.cfg.repo_term_secs => {
                    Err(Error::NotOverdue)
                }
                Some(_) => {
                    let rate = state.cfg.penalty_rate_bps;
                    let record = &mut state.repos[repo as usize];
                    record.status = RepoStatus::Penalty;
                    record.rate_bps = rate;
                    Ok(0)
                }
            },
        };
        state
    }
}

/// One of `cases`, made into a transition, or `fallback` when there is none.
fn pick<T: Clone + core::fmt::Debug + 'static>(
    cases: Vec<T>,
    fallback: BoxedStrategy<Transition>,
    to_transition: impl Fn(T) -> Transition + 'static,
) -> BoxedStrategy<Transition> {
    if cases.is_empty() {
        fallback
    } else {
        prop::sample::select(cases).prop_map(to_transition).boxed()
    }
}

/// The call's outcome as the model writes it; anything but a contract error is a failure.
fn outcome<T: Into<i128>, C: core::fmt::Debug, I: core::fmt::Debug>(
    result: Result<Result<T, C>, Result<Error, I>>,
) -> Result<i128, Error> {
    match result {
        Ok(Ok(value)) => Ok(value.into()),
        Err(Ok(err)) => Err(err),
        Ok(Err(conversion)) => panic!("conversion error: {conversion:?}"),
        Err(Err(i)) => panic!("untyped error: {i:?}"),
    }
}

/// `()` as the model's success value, 0.
fn unit<C>(result: Result<(), C>) -> Result<i128, C> {
    result.map(|()| 0)
}

pub struct SettlementMachine;

impl StateMachineTest for SettlementMachine {
    type SystemUnderTest = Setup;
    type Reference = Reference;

    fn init_test(model: &Model) -> Setup {
        Setup::with_config(BANKS, FUNDING, model.cfg.clone())
    }

    fn apply(sut: Setup, model: &Model, transition: Transition) -> Setup {
        {
            let client = sut.client();
            let address = |i: usize| {
                if i == CB {
                    sut.cb.clone()
                } else {
                    sut.bank(i).clone()
                }
            };
            let got = match transition {
                Transition::Deposit { bank, amount } => {
                    outcome(client.try_deposit(&address(bank), &amount).map(unit))
                }
                Transition::Withdraw { bank, amount } => {
                    outcome(client.try_withdraw(&address(bank), &amount).map(unit))
                }
                Transition::Submit {
                    from,
                    to,
                    amount,
                    priority,
                } => outcome(client.try_submit(&address(from), &address(to), &amount, &priority)),
                Transition::Revoke { id } => outcome(client.try_revoke(&id).map(unit)),
                Transition::Reprioritise { id, priority } => {
                    outcome(client.try_reprioritise(&id, &priority).map(unit))
                }
                Transition::Expire { id } => outcome(client.try_expire(&id).map(unit)),
                Transition::Tick { .. } => {
                    // The model has already moved its clock (A19).
                    sut.at(model.now);
                    Ok(0)
                }
                Transition::SetCollateral { bank, value } => {
                    outcome(client.try_set_collateral(&address(bank), &value).map(unit))
                }
                Transition::OpenRepo { bank, amount } => {
                    outcome(client.try_open_repo(&address(bank), &amount))
                }
                Transition::Repay {
                    actor,
                    repo,
                    amount,
                } => outcome(client.try_repay(&address(actor), &repo, &amount).map(unit)),
                Transition::ConvertOverdue { repo } => {
                    outcome(client.try_convert_overdue(&repo).map(unit))
                }
            };
            assert_eq!(got, model.last, "outcome of {transition:?}");

            for i in 0..BANKS {
                assert_eq!(
                    client.balance(sut.bank(i)),
                    model.balances[i],
                    "balance of bank {i}"
                );
                assert_eq!(
                    sut.token().balance(sut.bank(i)),
                    model.holding[i],
                    "holding of bank {i}"
                );
                assert_eq!(
                    client.credit(sut.bank(i)),
                    model.credit(i),
                    "credit of bank {i}"
                );
                for priority in [Priority::Urgent, Priority::Normal] {
                    assert_eq!(
                        sut.queue(i, priority),
                        model.queue(i, priority),
                        "{priority:?} queue of bank {i}"
                    );
                }
            }
            for (id, payment) in &model.payments {
                let expected = Payment {
                    id: *id,
                    from: address(payment.from),
                    to: address(payment.to),
                    amount: payment.amount,
                    priority: payment.priority,
                    submitted_at: payment.submitted_at,
                    status: payment.status,
                    settled_at: payment.settled_at,
                };
                assert_eq!(client.payment(id), Some(expected), "payment {id}");
            }
            assert_eq!(
                client.payment(&model.next_id),
                None,
                "payment {}",
                model.next_id
            );
            let queued = model
                .payments
                .values()
                .filter(|payment| payment.status == Status::Queued)
                .count();
            assert_eq!(client.queued_count() as usize, queued, "queued_count");
            for (id, repo) in model.repos.iter().enumerate() {
                let expected = Repo {
                    id: id as u64,
                    bank: address(repo.bank),
                    amount: repo.amount,
                    outstanding: repo.outstanding,
                    opened_at: repo.opened_at,
                    status: repo.status,
                    rate_bps: repo.rate_bps,
                };
                assert_eq!(client.repo(&(id as u64)), Some(expected), "repo {id}");
            }
            assert_eq!(
                client.repo(&(model.repos.len() as u64)),
                None,
                "repo {}",
                model.repos.len()
            );
        }
        sut
    }

    /// S1 and S2 after every call (ADR-0004, ADR-0011).
    fn check_invariants(sut: &Setup, _: &Model) {
        sut.assert_conserved();
    }
}

prop_state_machine! {
    #![proptest_config(config(32))]

    /// The contract refines the reference model: every call's outcome, every balance,
    /// holding, queue, payment record and repo match it (A1, A2, A3, A5, A6, A8, A11–A14,
    /// A19, A20; S1–S5, S7, S9–S11, S13, S17, S21, S23; R4, R6; ADR-0004, ADR-0005,
    /// ADR-0008 to ADR-0011, ADR-0013 to ADR-0018).
    #[test]
    fn the_contract_refines_the_reference_model(sequential 1..40 => SettlementMachine);
}
