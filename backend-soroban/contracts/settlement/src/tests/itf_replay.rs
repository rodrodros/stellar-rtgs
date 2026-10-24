//! Model-based tests: Quint traces (ITF JSON) replayed against the contract (TESTING.md §3).
//!
//! `quint/settlement.qnt` is the oracle, and `make quint-traces` regenerates the traces in
//! `quint/traces/`. Each state records `mbt::actionTaken`, the contract call the model made,
//! and `mbt::nondetPicks`, its arguments. The replay makes the same call, and requires the
//! same outcome (success value or error name) and exactly the same resulting state:
//! balances, cash held outside, both queues of every bank and every payment record. The
//! `Offset` and `Settled` events are compared as a multiset, with the offsets in order and
//! each before its own settlements, because the order in which the contract visits banks
//! is its own choice (R2; see [`match_settlement_events`]).
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

/// Compares one call's `Offset` and `Settled` events with the model's.
///
/// `offsets` holds each expected `Offset` event with its own `Settled` events, and `gross`
/// the `Settled` events of gross settlement. The comparison is deliberately loose about
/// order. Under strict FIFO the scan order of the eager closure does not change the state
/// it ends in (R2), but it does change the order of the `Settled` events, and the contract
/// may visit banks in any order. So the events must be the same multiset, the `Offset`
/// events must come in the model's order, and each offset's `Settled` events must come
/// after its own `Offset` event (A3). Which offsets happen does not depend on the scan
/// order: an offset runs only at rest, and the state at rest is unique (R2, R6).
fn match_settlement_events<E: PartialEq + core::fmt::Debug>(
    actual: &[E],
    offsets: &[(E, StdVec<E>)],
    gross: &[E],
) -> Result<(), String> {
    let mut pool: StdVec<&E> = offsets
        .iter()
        .flat_map(|(o, settled)| core::iter::once(o).chain(settled))
        .chain(gross)
        .collect();
    for e in actual {
        let i = pool
            .iter()
            .position(|x| *x == e)
            .ok_or_else(|| format!("unexpected event {e:?}"))?;
        pool.swap_remove(i);
    }
    if !pool.is_empty() {
        return Err(format!("missing events {pool:?}"));
    }
    let at = |e: &E| actual.iter().position(|x| x == e).unwrap();
    let mut last = None;
    for (o, settled) in offsets {
        let here = at(o);
        if last.is_some_and(|l| here < l) {
            return Err(format!("offset {o:?} out of order"));
        }
        last = Some(here);
        if let Some(early) = settled.iter().find(|e| at(e) < here) {
            return Err(format!("{early:?} comes before its offset {o:?}"));
        }
    }
    Ok(())
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

    fn settled_event(&self, v: &State, id: u64) -> xdr::ContractEvent {
        let p = &v.payments[&id];
        self.s.ev(Settled {
            id,
            from: self.addr[&p.payer].clone(),
            to: self.addr[&p.payee].clone(),
            amount: p.amount,
        })
    }

    /// The model's step as [`match_settlement_events`] takes it: each `Offset` event with
    /// its own `Settled` events, then the `Settled` events of gross settlement.
    #[allow(clippy::type_complexity)]
    fn expected_events(
        &self,
        v: &State,
    ) -> (
        StdVec<(xdr::ContractEvent, StdVec<xdr::ContractEvent>)>,
        StdVec<xdr::ContractEvent>,
    ) {
        let offsets = v
            .offsets_now
            .iter()
            .map(|ids| {
                let mut list = vec![&self.s.env];
                ids.iter().for_each(|i| list.push_back(*i));
                let settled = ids.iter().map(|i| self.settled_event(v, *i)).collect();
                (self.s.ev(Offset { ids: list }), settled)
            })
            .collect();
        let gross = v
            .settled_now
            .iter()
            .filter(|i| !v.offsets_now.iter().any(|ids| ids.contains(i)))
            .map(|i| self.settled_event(v, *i))
            .collect();
        (offsets, gross)
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
            "depositStep" | "depositLargeStep" => outcome(
                c.try_deposit(r.a(&picks.bank), &picks.amount.unwrap())
                    .map(|ok| ok.map(|()| 0i128)),
            ),
            "withdrawStep" => outcome(
                c.try_withdraw(r.a(&picks.bank), &picks.amount.unwrap())
                    .map(|ok| ok.map(|()| 0i128)),
            ),
            "submitStep" | "submitToSelfStep" => outcome(
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
            let (offsets, gross) = r.expected_events(v);
            if let Err(e) = match_settlement_events(&r.settlement_events(), &offsets, &gross) {
                panic!("{at}: Offset and Settled events: {e}");
            }
        }
        r.check(v, &at);
    }
    trace.states.len() - 1
}

/// Replays every committed Quint trace, step by step. The traces exercise A1 `Submit`,
/// A2 `Settle` and A3 `Offset` in the eager closure, A5 expiry, A6 `Revoke`,
/// A8 `Reprioritise` and A19 `Tick`, with funding in between. Each step must match the
/// model's outcome and state, and its events up to the bank order (R2), so the contract
/// inherits the model's checked invariants S1, S2, S3, S5, S7, S9, S11 and S23 (ADR-0008, ADR-0009, ADR-0010, ADR-0015,
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

/// The calls the replay knows how to make, by the model's action name.
const ACTIONS: [&str; 10] = [
    "depositStep",
    "depositLargeStep",
    "withdrawStep",
    "submitStep",
    "submitToSelfStep",
    "revokeStep",
    "reprioritiseStep",
    "expireStep",
    "tickStep",
    "init",
];

/// The replay's own assumptions about the traces, checked without the contract.
/// - Every trace decodes, and every step is a call the replay knows.
/// - Every offset is ascending and has at least two payments, since a lone covered head
///   settles gross (A3, S9).
/// - The traces reach each path the replay must exercise: every error the modelled calls
///   return; an offset; an urgent payment settled past an older normal one (S7(a),
///   ADR-0009); four or more payments queued; and one call that settles three or more
///   (S9). These are the model's witnesses, which `quint run` reports but does not enforce.
/// - Self-payments (`SameAccount`) are at most an eighth of the submissions, so the
///   generator does not waste steps on them. The model weights them one in nine.
#[test]
fn quint_traces_decode_and_cover_the_paths_the_replay_checks() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut hit = |k: &str| *seen.entry(String::from(k)).or_default() += 1;
    let (mut submits, mut to_self) = (0, 0);
    for path in trace_files() {
        let data = std::fs::read_to_string(&path).unwrap();
        let trace: itf::Trace<State> = itf::trace_from_str(&data).unwrap();
        for state in &trace.states {
            let v = &state.value;
            assert!(
                ACTIONS.contains(&v.action_taken.as_str()),
                "{path:?}: {}",
                v.action_taken
            );
            for ids in &v.offsets_now {
                assert!(ids.len() >= 2, "{path:?}: offset {ids:?}");
                assert!(ids.windows(2).all(|w| w[0] < w[1]), "{path:?}: {ids:?}");
                assert!(
                    ids.iter().all(|i| v.settled_now.contains(i)),
                    "{path:?}: {ids:?}"
                );
                hit("offset");
            }
            for id in &v.settled_now {
                assert_eq!(v.payments[id].status, "Settled");
            }
            if !v.last_error.is_empty() {
                hit(&v.last_error);
            }
            if v.action_taken.starts_with("submit") {
                submits += 1;
                to_self += usize::from(v.last_error == "SameAccount");
            }
            let queued: StdVec<&ModelPayment> = v
                .payments
                .values()
                .filter(|p| p.status == "Queued")
                .collect();
            if queued.len() >= 4 {
                hit("deep queue");
            }
            if v.settled_now.len() >= 3 {
                hit("cascade");
            }
            if v.payments.values().any(|u| {
                u.status == "Settled"
                    && u.priority == "Urgent"
                    && queued
                        .iter()
                        .any(|o| o.priority == "Normal" && o.payer == u.payer && o.id < u.id)
            }) {
                hit("urgent overtook");
            }
        }
    }
    for path in [
        "offset",
        "deep queue",
        "cascade",
        "urgent overtook",
        "TokenTransferFailed",
        "InsufficientFunds",
        "SameAccount",
        "QueueFull",
        "UnknownPayment",
        "NotQueued",
        "SamePriority",
        "NotExpired",
    ] {
        assert!(seen.contains_key(path), "no trace reaches {path}: {seen:?}");
    }
    assert!(
        8 * to_self <= submits,
        "{to_self} of {submits} submissions are to self"
    );
}

/// The event comparison of [`match_settlement_events`], on stand-in events: `'o'` and `'p'`
/// are `Offset` events, and digits are `Settled` events. R2: gross settlement in another
/// bank order still matches. A3: the offsets must keep their order and come before their
/// own settlements. Missing, extra and duplicated events never match.
#[test]
fn settlement_events_match_as_a_set_with_each_offset_before_its_own_settlements() {
    let offsets = [('o', std::vec!['1', '2']), ('p', std::vec!['5', '6'])];
    let gross = ['3', '4'];
    let ok = |a: &str| match_settlement_events(&a.chars().collect::<StdVec<_>>(), &offsets, &gross);
    assert_eq!(ok("o12p5634"), Ok(()));
    assert_eq!(
        ok("43o21p65"),
        Ok(()),
        "gross and offset settlements in another order"
    );
    assert_eq!(ok("o1p25634"), Ok(()), "two offsets interleaved");
    assert!(
        ok("1o2p5634").is_err(),
        "a settlement before its own offset"
    );
    assert!(ok("p56o1234").is_err(), "offsets out of order");
    assert!(ok("o12p563").is_err(), "a missing settlement");
    assert!(ok("o12p56344").is_err(), "a duplicated settlement");
    assert!(ok("o12p56347").is_err(), "an extra settlement");
    assert!(ok("o12p5634q").is_err(), "an extra offset");
    let none: [(char, StdVec<char>); 0] = [];
    assert_eq!(match_settlement_events(&['4', '3'], &none, &gross), Ok(()));
}
