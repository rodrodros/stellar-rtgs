//! Model-based tests: Quint traces (ITF JSON) replayed against the contract (TESTING.md §3).
//!
//! `quint/settlement.qnt` is the oracle, and `make quint-traces` regenerates the traces in
//! `quint/traces/`. Each state records `mbt::actionTaken`, the contract call the model made,
//! and `mbt::nondetPicks`, its arguments. The replay makes the same call, and requires the
//! same outcome (success value or error name), the same `Offset` and `Settled` events, and
//! the same resulting state: balances, cash held outside, both queues of every bank and
//! every payment record.
use std::{collections::BTreeMap, format, string::String, vec::Vec as StdVec};

use itf::de::{self, As};
use serde::Deserialize;
use soroban_sdk::{
    vec,
    xdr::{self, ContractEventBody, ScVal},
    Address,
};

use super::support::{default_config, Setup};
use crate::{Config, Offset, Payment, Priority, Settled, Status};

const TRACES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../quint/traces");

/// The model's `QUEUE_CAP` and `EXPIRY`.
fn model_config() -> Config {
    Config {
        queue_cap: 6,
        expiry_secs: 10,
        ..default_config()
    }
}

#[derive(Clone, Debug, Deserialize)]
struct ModelPayment {
    id: u64,
    payer: String,
    payee: String,
    amount: i128,
    priority: String,
    #[serde(rename = "submittedAt")]
    submitted_at: u64,
    status: String,
    /// -1 until the payment settles.
    #[serde(rename = "settledAt")]
    settled_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
struct NondetPicks {
    #[serde(with = "As::<de::Option::<_>>")]
    bank: Option<String>,
    #[serde(with = "As::<de::Option::<_>>")]
    payee: Option<String>,
    #[serde(with = "As::<de::Option::<_>>")]
    amount: Option<i128>,
    #[serde(with = "As::<de::Option::<_>>")]
    priority: Option<String>,
    #[serde(with = "As::<de::Option::<_>>")]
    id: Option<u64>,
    #[serde(with = "As::<de::Option::<_>>")]
    dt: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
struct State {
    reserve: BTreeMap<String, i128>,
    balances: BTreeMap<String, i128>,
    payments: BTreeMap<u64, ModelPayment>,
    #[serde(rename = "nextId")]
    next_id: u64,
    now: u64,
    #[serde(rename = "lastError")]
    last_error: String,
    #[serde(rename = "lastValue")]
    last_value: i128,
    #[serde(rename = "settledNow")]
    settled_now: StdVec<u64>,
    #[serde(rename = "offsetsNow")]
    offsets_now: StdVec<StdVec<u64>>,
    #[serde(rename = "mbt::actionTaken")]
    action_taken: String,
    #[serde(rename = "mbt::nondetPicks")]
    nondet_picks: NondetPicks,
}

fn priority(name: &str) -> Priority {
    match name {
        "Normal" => Priority::Normal,
        "Urgent" => Priority::Urgent,
        other => panic!("unknown priority {other}"),
    }
}

fn status(name: &str) -> Status {
    match name {
        "Queued" => Status::Queued,
        "Settled" => Status::Settled,
        "Revoked" => Status::Revoked,
        "Expired" => Status::Expired,
        other => panic!("unknown status {other}"),
    }
}

/// Maps a client `try_` result to the model's encoding: the success value, or the error name.
fn outcome<T, C, I>(r: Result<Result<T, C>, Result<crate::Error, I>>) -> Result<i128, String>
where
    T: Into<i128>,
    C: core::fmt::Debug,
    I: core::fmt::Debug,
{
    match r {
        Ok(Ok(v)) => Ok(v.into()),
        Err(Ok(e)) => Err(format!("{e:?}")),
        other => panic!(
            "untyped outcome: {:?}",
            other.map(|_| ()).map_err(|e| e.map(|_| ()))
        ),
    }
}

/// The first topic of an event, which `#[contractevent]` sets to the event's name.
fn event_name(e: &xdr::ContractEvent) -> StdVec<u8> {
    let ContractEventBody::V0(body) = &e.body;
    match body.topics.first() {
        Some(ScVal::Symbol(name)) => name.as_vec().clone(),
        _ => StdVec::new(),
    }
}

struct Replay {
    s: Setup,
    addr: BTreeMap<String, Address>,
}

impl Replay {
    fn a(&self, name: &Option<String>) -> &Address {
        &self.addr[name.as_ref().expect("pick present")]
    }

    fn payment(&self, p: &ModelPayment) -> Payment {
        Payment {
            id: p.id,
            from: self.addr[&p.payer].clone(),
            to: self.addr[&p.payee].clone(),
            amount: p.amount,
            priority: priority(&p.priority),
            submitted_at: p.submitted_at,
            status: status(&p.status),
            settled_at: u64::try_from(p.settled_at).ok(),
        }
    }

    /// The `Offset` and `Settled` events the model's step implies, in order. Each offset's
    /// ids are a contiguous run of `settledNow`, and its `Offset` event comes before the
    /// first of their `Settled` events.
    fn expected_events(&self, v: &State) -> StdVec<xdr::ContractEvent> {
        let mut out = StdVec::new();
        for id in &v.settled_now {
            if let Some(ids) = v.offsets_now.iter().find(|ids| ids.first() == Some(id)) {
                let mut list = vec![&self.s.env];
                ids.iter().for_each(|i| list.push_back(*i));
                out.push(self.s.ev(Offset { ids: list }));
            }
            let p = &v.payments[id];
            out.push(self.s.ev(Settled {
                id: *id,
                from: self.addr[&p.payer].clone(),
                to: self.addr[&p.payee].clone(),
                amount: p.amount,
            }));
        }
        out
    }

    /// The contract's `Offset` and `Settled` events from the last call (C-HB-132).
    fn settlement_events(&self) -> StdVec<xdr::ContractEvent> {
        self.s
            .our_events()
            .into_iter()
            .filter(|e| matches!(event_name(e).as_slice(), b"settled" | b"offset"))
            .collect()
    }

    fn check(&self, v: &State, at: &str) {
        let c = self.s.client();
        let token = self.s.token();
        for (name, a) in &self.addr {
            assert_eq!(c.balance(a), v.balances[name], "{at}: balance of {name}");
            assert_eq!(
                token.balance(a),
                v.reserve[name],
                "{at}: cash held by {name}"
            );
            for p in ["Urgent", "Normal"] {
                let model: StdVec<u64> = v
                    .payments
                    .values()
                    .filter(|m| m.status == "Queued" && m.payer == *name && m.priority == p)
                    .map(|m| m.id)
                    .collect();
                let got: StdVec<u64> = c.queue(a, &priority(p)).iter().collect();
                assert_eq!(got, model, "{at}: {p} queue of {name}");
            }
        }
        self.s.assert_conserved();
        let queued = v.payments.values().filter(|m| m.status == "Queued").count();
        assert_eq!(c.queued_count() as usize, queued, "{at}: queued count");
        for p in v.payments.values() {
            assert_eq!(
                c.payment(&p.id),
                Some(self.payment(p)),
                "{at}: payment {}",
                p.id
            );
        }
        assert_eq!(c.payment(&v.next_id), None, "{at}: next id is unused");
    }
}

fn replay(path: &std::path::Path) -> usize {
    let data = std::fs::read_to_string(path).unwrap();
    let trace: itf::Trace<State> = itf::trace_from_str(&data).unwrap();
    let init = &trace.states[0].value;
    assert_eq!(init.action_taken, "init");
    let funding = *init.reserve.values().next().unwrap();
    assert!(init.reserve.values().all(|r| *r == funding));
    let s = Setup::with_config(init.reserve.len(), funding, model_config());
    // BTreeMap order is alphabetical, so the mapping from names to banks is stable.
    let addr = init
        .reserve
        .keys()
        .cloned()
        .zip(s.banks.iter().cloned())
        .collect();
    let r = Replay { s, addr };
    let file = path.file_name().unwrap().to_string_lossy();
    r.s.at(init.now);
    r.check(init, &format!("{file} state 0"));

    for (i, state) in trace.states.iter().enumerate().skip(1) {
        let v = &state.value;
        let picks = &v.nondet_picks;
        let at = format!("{file} state {i} ({} {picks:?})", v.action_taken);
        let c = r.s.client();
        let got = match v.action_taken.as_str() {
            "depositStep" => outcome(
                c.try_deposit(r.a(&picks.bank), &picks.amount.unwrap())
                    .map(|ok| ok.map(|()| 0i128)),
            ),
            "withdrawStep" => outcome(
                c.try_withdraw(r.a(&picks.bank), &picks.amount.unwrap())
                    .map(|ok| ok.map(|()| 0i128)),
            ),
            "submitStep" => outcome(
                c.try_submit(
                    r.a(&picks.bank),
                    r.a(&picks.payee),
                    &picks.amount.unwrap(),
                    &priority(picks.priority.as_ref().unwrap()),
                )
                .map(|ok| ok.map(i128::from)),
            ),
            "revokeStep" => outcome(
                c.try_revoke(&picks.id.unwrap())
                    .map(|ok| ok.map(|()| 0i128)),
            ),
            "reprioritiseStep" => outcome(
                c.try_reprioritise(
                    &picks.id.unwrap(),
                    &priority(picks.priority.as_ref().unwrap()),
                )
                .map(|ok| ok.map(|()| 0i128)),
            ),
            "expireStep" => outcome(
                c.try_expire(&picks.id.unwrap())
                    .map(|ok| ok.map(|()| 0i128)),
            ),
            // A19: no contract call, only the ledger's close time moves.
            "tickStep" => {
                assert_eq!(r.s.env.ledger().timestamp() + picks.dt.unwrap(), v.now);
                r.s.at(v.now);
                Ok(0)
            }
            other => panic!("{at}: unknown action {other}"),
        };
        let expected = if v.last_error.is_empty() {
            Ok(v.last_value)
        } else {
            Err(v.last_error.clone())
        };
        assert_eq!(got, expected, "{at}: outcome");
        if v.action_taken != "tickStep" {
            assert_eq!(
                r.settlement_events(),
                r.expected_events(v),
                "{at}: Offset and Settled events"
            );
        }
        r.check(v, &at);
    }
    trace.states.len() - 1
}

/// Replays every committed Quint trace, step by step. The traces exercise A1 `Submit`,
/// A2 `Settle` and A3 `Offset` in the eager closure, A5 expiry, A6 `Revoke`,
/// A8 `Reprioritise` and A19 `Tick`, with funding in between. Each step must match the
/// model's outcome, events and state, so the contract inherits the model's checked
/// invariants S1, S2, S3, S5, S7, S9, S11 and S23 (ADR-0008, ADR-0009, ADR-0010, ADR-0015,
/// ADR-0016). Where the model departs from the definition (no business day, expiry
/// instead of cut-offs), `quint/settlement.qnt`'s header says why (ADR-0013 to ADR-0018).
#[test]
fn quint_traces_replay_against_the_contract() {
    let files = trace_files();
    let steps: usize = files.iter().map(|p| replay(p)).sum();
    std::println!("replayed {} traces, {steps} steps", files.len());
}

fn trace_files() -> StdVec<std::path::PathBuf> {
    let mut files: StdVec<_> = std::fs::read_dir(TRACES)
        .expect("trace directory exists")
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with(".itf.json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no traces in {TRACES}");
    files
}

/// The replay's own assumptions about the traces, checked without the contract. Every
/// trace decodes. Each offset is a contiguous, ascending run of `settledNow`, so
/// `expected_events` can place its `Offset` event (A3, ADR-0010). Every offset has at
/// least two payments, since a lone covered head settles gross (S9). The traces reach an
/// offset, an expiry, a revocation and `QueueFull`, so the replay exercises them.
#[test]
fn quint_traces_decode_and_cover_the_paths_the_replay_checks() {
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    for path in trace_files() {
        let data = std::fs::read_to_string(&path).unwrap();
        let trace: itf::Trace<State> = itf::trace_from_str(&data).unwrap();
        for state in &trace.states {
            let v = &state.value;
            for ids in &v.offsets_now {
                assert!(ids.len() >= 2, "{path:?}: offset {ids:?}");
                assert!(ids.windows(2).all(|w| w[0] < w[1]), "{path:?}: {ids:?}");
                let at = v.settled_now.iter().position(|i| *i == ids[0]).unwrap();
                assert_eq!(&v.settled_now[at..at + ids.len()], ids.as_slice());
                *seen.entry("offset").or_default() += 1;
            }
            for id in &v.settled_now {
                assert_eq!(v.payments[id].status, "Settled");
            }
            match v.last_error.as_str() {
                "QueueFull" => *seen.entry("QueueFull").or_default() += 1,
                "" if v.action_taken == "expireStep" => *seen.entry("expire").or_default() += 1,
                "" if v.action_taken == "revokeStep" => *seen.entry("revoke").or_default() += 1,
                "" if v.action_taken == "reprioritiseStep" => {
                    *seen.entry("reprioritise").or_default() += 1
                }
                _ => {}
            }
        }
    }
    for path in ["offset", "QueueFull", "expire", "revoke", "reprioritise"] {
        assert!(seen.contains_key(path), "no trace reaches {path}: {seen:?}");
    }
}
