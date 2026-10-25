//! Property tests for the pure rules (TESTING.md, "Property and state-machine tests").
//!
//! The oracle enumerates every prefix vector of small instances and keeps the feasible
//! ones (F1 with `lim` = 0, §4.5), decided over the integers: queued sums can exceed
//! `i128`, and an overflow must never decide feasibility. Then the feasible vectors are
//! closed under join (R4) and R5 holds at every amount, the `i128` edges included.
extern crate std;

use alloc::vec::Vec;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngSeed};

use super::{covers, greatest_feasible_prefix, Candidate};

/// The settings `make test` runs with: a pinned seed and `cases` cases. To explore
/// further, set `PROPTEST_RNG_SEED` and `PROPTEST_CASES`, which win over these.
fn config(cases: u32) -> Config {
    let mut c = Config::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        c.cases = cases;
    }
    if std::env::var_os("PROPTEST_RNG_SEED").is_none() {
        c.rng_seed = RngSeed::Fixed(0x5e771e);
    }
    // A pinned seed reproduces any failure, so there is nothing to persist.
    c.failure_persistence = None;
    c
}

/// An instance of the prefix rule: every account's balance and its candidates in `≺`
/// order.
#[derive(Clone, Debug)]
struct Instance {
    balances: Vec<i128>,
    queues: Vec<Vec<Candidate>>,
}

/// 2 to 4 accounts, each with up to 3 candidates to other accounts. Payments are
/// positive (S11) and balances small and non-negative (S2 with `lim` = 0), so that, as in
/// the contract (S1), every balance a feasible offset leaves fits in `i128`.
fn instance_with(amount: BoxedStrategy<i128>) -> impl Strategy<Value = Instance> {
    (2usize..=4).prop_flat_map(move |n| {
        let candidate = (1..n, amount.clone());
        (
            prop::collection::vec(0i128..=60, n),
            prop::collection::vec(prop::collection::vec(candidate, 0..=3), n),
        )
            .prop_map(move |(balances, raw)| Instance {
                balances,
                queues: raw
                    .into_iter()
                    .enumerate()
                    .map(|(a, q)| {
                        q.into_iter()
                            .map(|(offset, amount)| Candidate {
                                to: (a + offset) % n,
                                amount,
                            })
                            .collect()
                    })
                    .collect(),
            })
    })
}

/// Small amounts, with a few equal values so that exact fits are common.
fn small() -> BoxedStrategy<i128> {
    prop_oneof![3 => 1i128..=60, 1 => Just(10i128), 1 => Just(20i128)].boxed()
}

/// Amounts at the `i128` limit as well as small ones.
fn edgy() -> BoxedStrategy<i128> {
    prop_oneof![
        3 => 1i128..=60,
        1 => Just(i128::MAX),
        1 => Just(i128::MAX / 2 + 1),
        1 => (i128::MAX - 60)..=i128::MAX,
    ]
    .boxed()
}

/// F1 with `lim` = 0: every account ends non-negative when the first `k[a]` candidates
/// of every account `a` settle, i.e. its outflow is at most its balance plus its inflow,
/// over the integers.
fn feasible(i: &Instance, k: &[usize]) -> bool {
    (0..i.balances.len()).all(|a| {
        let outflow = i.queues[a][..k[a]].iter().map(|c| c.amount);
        let inflow = i
            .queues
            .iter()
            .enumerate()
            .flat_map(|(p, q)| &q[..k[p]])
            .filter(|c| c.to == a)
            .map(|c| c.amount);
        net_is_non_negative(i.balances[a], inflow, outflow)
    })
}

/// Whether `balance + Σ inflow − Σ outflow ≥ 0`, decided exactly. The sums can exceed
/// `i128`, so each amount is split into 64-bit halves, whose sums cannot overflow.
fn net_is_non_negative(
    balance: i128,
    inflow: impl Iterator<Item = i128>,
    outflow: impl Iterator<Item = i128>,
) -> bool {
    const HALF: i128 = 1 << 64;
    let (mut hi, mut lo) = (balance.div_euclid(HALF), balance.rem_euclid(HALF));
    for a in inflow {
        hi += a.div_euclid(HALF);
        lo += a.rem_euclid(HALF);
    }
    for a in outflow {
        hi -= a.div_euclid(HALF);
        lo -= a.rem_euclid(HALF);
    }
    // The net is `hi · 2^64 + lo`; with `lo` carried into [0, 2^64), its sign is `hi`'s.
    hi + lo.div_euclid(HALF) >= 0
}

/// The balances after the first `k[a]` candidates of every `a` settle. Only for small
/// instances: it panics on overflow.
fn end_balances(i: &Instance, k: &[usize]) -> Vec<i128> {
    let mut b = i.balances.clone();
    for (a, q) in i.queues.iter().enumerate() {
        for c in &q[..k[a]] {
            b[a] -= c.amount;
            b[c.to] += c.amount;
        }
    }
    b
}

/// Every prefix vector of the instance.
fn all_prefixes(i: &Instance) -> Vec<Vec<usize>> {
    let mut all = alloc::vec![Vec::new()];
    for q in &i.queues {
        all = all
            .into_iter()
            .flat_map(|k| {
                (0..=q.len()).map(move |len| {
                    let mut k = k.clone();
                    k.push(len);
                    k
                })
            })
            .collect();
    }
    all
}

fn le(a: &[usize], b: &[usize]) -> bool {
    a.iter().zip(b).all(|(x, y)| x <= y)
}

/// Strict FIFO gross processing (A2 only): settle any account's covered head until none
/// is covered. Its result is `k_seq` (§4.10, R6).
fn gross_only(i: &Instance) -> Vec<usize> {
    let mut balances = i.balances.clone();
    let mut k = alloc::vec![0usize; balances.len()];
    loop {
        let mut progressed = false;
        for (a, q) in i.queues.iter().enumerate() {
            while let Some(c) = q.get(k[a]) {
                if balances[a] < c.amount {
                    break;
                }
                balances[a] -= c.amount;
                balances[c.to] += c.amount;
                k[a] += 1;
                progressed = true;
            }
        }
        if !progressed {
            return k;
        }
    }
}

/// The instance left after the first `k[a]` candidates of every `a` settle.
fn after(i: &Instance, k: &[usize]) -> Instance {
    Instance {
        balances: end_balances(i, k),
        queues: i
            .queues
            .iter()
            .zip(k)
            .map(|(q, k)| q[*k..].to_vec())
            .collect(),
    }
}

proptest! {
    #![proptest_config(config(512))]

    /// A2's guard §4.5 `cov`, which keeps S2, with no credit line and no reservations:
    /// covered exactly when `bal − a ≥ 0`, over the whole `i128` range and without overflow
    /// (ADR-0011, ADR-0018).
    /// Uniform `i128` pairs almost never meet, so the boundary is drawn on purpose:
    /// `amount` is `balance`, one more or one less, as often as it is random.
    #[test]
    fn covers_is_exactly_balance_at_least_amount(
        (balance, amount) in any::<i128>().prop_flat_map(|b| {
            let near = prop_oneof![
                Just(b),
                Just(b.saturating_add(1)),
                Just(b.saturating_sub(1)),
            ];
            (Just(b), prop_oneof![1 => near, 1 => any::<i128>()])
        })
    ) {
        prop_assert_eq!(covers(balance, amount), balance >= amount);
    }

    /// R4, S10: k* has one entry per account and never exceeds an account's queue (§4.5,
    /// Spec O; ADR-0010).
    #[test]
    fn the_prefix_is_within_every_queue(i in instance_with(small())) {
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        prop_assert_eq!(k.len(), i.balances.len());
        for (a, q) in i.queues.iter().enumerate() {
            prop_assert!(k[a] <= q.len(), "k[{}] = {} > {}", a, k[a], q.len());
        }
    }

    /// The prefix the offset settles is feasible: F1 with `lim` = 0 (S10, S2; ADR-0010).
    #[test]
    fn the_prefix_is_feasible(i in instance_with(small())) {
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        prop_assert!(feasible(&i, &k), "infeasible k = {:?}", k);
    }

    /// R4: the feasible prefix vectors are closed under join, so a greatest one
    /// exists and is unique, and the rule returns it. Checked against every prefix vector
    /// (ADR-0010).
    #[test]
    fn the_prefix_is_the_greatest_feasible_one(i in instance_with(small())) {
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        let feasible: Vec<Vec<usize>> =
            all_prefixes(&i).into_iter().filter(|p| feasible(&i, p)).collect();
        let join: Vec<usize> = (0..i.balances.len())
            .map(|a| feasible.iter().map(|p| p[a]).max().unwrap_or(0))
            .collect();
        prop_assert!(feasible.contains(&join), "R4: the join {:?} is infeasible", join);
        for p in &feasible {
            prop_assert!(le(p, &k), "feasible {:?} is not below k* {:?}", p, k);
        }
        prop_assert_eq!(k, join);
    }

    /// R4: k* is defined by the accounts, not their order. Relabelling the accounts
    /// relabels k* the same way (ADR-0010).
    #[test]
    fn the_prefix_does_not_depend_on_the_account_order(
        (i, perm) in instance_with(small()).prop_flat_map(|i| {
            let n = i.balances.len();
            (Just(i), Just((0..n).collect::<Vec<usize>>()).prop_shuffle())
        })
    ) {
        // Account `a` becomes account `perm[a]`.
        let n = i.balances.len();
        let mut balances = alloc::vec![0; n];
        let mut queues = alloc::vec![Vec::new(); n];
        for a in 0..n {
            balances[perm[a]] = i.balances[a];
            queues[perm[a]] = i.queues[a]
                .iter()
                .map(|c| Candidate { to: perm[c.to], amount: c.amount })
                .collect();
        }
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        let relabelled = greatest_feasible_prefix(&balances, &queues);
        for a in 0..n {
            prop_assert_eq!(relabelled[perm[a]], k[a], "account {}", a);
        }
    }

    /// R4: more liquidity never settles less. Raising one balance gives a k* at least as
    /// great in every account (ADR-0010).
    #[test]
    fn more_liquidity_never_shrinks_the_prefix(
        i in instance_with(small()),
        who in any::<prop::sample::Index>(),
        extra in 0i128..=60,
    ) {
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        let mut richer = i.clone();
        richer.balances[who.index(i.balances.len())] += extra;
        let k2 = greatest_feasible_prefix(&richer.balances, &richer.queues);
        prop_assert!(le(&k, &k2), "{:?} then {:?}", k, k2);
    }

    /// R6: strict FIFO gross processing alone stops at `k_seq ≤ k*`, so the offset never
    /// settles less than gross processing would (R7 shows it can settle more; ADR-0010).
    #[test]
    fn gross_processing_never_beats_the_offset(i in instance_with(small())) {
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        let k_seq = gross_only(&i);
        prop_assert!(le(&k_seq, &k), "k_seq {:?} > k* {:?}", k_seq, k);
    }

    /// R5 and S23: after the offset of k*, the greatest feasible prefix of what is left
    /// is zero, so the queues are at rest until something external happens (ADR-0010).
    #[test]
    fn after_the_offset_nothing_more_is_feasible(i in instance_with(small())) {
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        prop_assume!(feasible(&i, &k));
        let rest = after(&i, &k);
        let k2 = greatest_feasible_prefix(&rest.balances, &rest.queues);
        prop_assert!(k2.iter().all(|x| *x == 0), "R5: k* of the rest is {:?}", k2);
    }

    /// F2: the prefix of an account whose first candidate exceeds its balance plus every
    /// payment it could receive is zero, so nothing behind that candidate overtakes it
    /// (S7, ADR-0008).
    #[test]
    fn a_candidate_no_inflow_can_cover_blocks_its_queue(i in instance_with(small())) {
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        for (a, q) in i.queues.iter().enumerate() {
            let Some(head) = q.first() else { continue };
            let max_in: i128 = i
                .queues
                .iter()
                .flatten()
                .filter(|c| c.to == a)
                .map(|c| c.amount)
                .sum();
            if head.amount > i.balances[a] + max_in {
                prop_assert_eq!(k[a], 0, "account {} overtook its head", a);
            }
        }
    }

    /// Amounts at the `i128` limit: the rule never panics, decides F1 exactly although the
    /// sums exceed `i128`, and returns the greatest feasible prefix (S2, S10, R4;
    /// ADR-0010).
    #[test]
    fn sums_beyond_i128_are_decided_exactly_not_a_panic(i in instance_with(edgy())) {
        let k = greatest_feasible_prefix(&i.balances, &i.queues);
        prop_assert!(feasible(&i, &k), "infeasible k = {:?}", k);
        for p in all_prefixes(&i).iter().filter(|p| feasible(&i, p)) {
            prop_assert!(le(p, &k), "feasible {:?} is not below k* {:?}", p, k);
        }
    }
}

/// F1 and R5 beyond `i128` (SC-A03-11; ADR-0010). With every balance 0, A queues A→B
/// and A→C, B queues B→A and C queues C→A, all `i128::MAX`: A's outflow, 2 · `i128::MAX`,
/// is met by its inflow, so k* = (2, 1, 1) in one offset. And with A at 1, A→B twice
/// `i128::MAX / 2 + 1` against B→A `i128::MAX`, A ends at 0 and B at 1: k* = (2, 1).
/// An overflow-based rule would settle the first only in two offsets, (1, 1, 0) and then
/// (1, 0, 1), which breaks R5; it would settle nothing at all in the second.
#[test]
fn at_the_i128_limit_sums_are_decided_exactly() {
    let c = |to, amount| Candidate { to, amount };
    let (max, h) = (i128::MAX, i128::MAX / 2 + 1);
    let edge = [
        std::vec![c(1, max), c(2, max)],
        std::vec![c(0, max)],
        std::vec![c(0, max)],
    ];
    assert_eq!(greatest_feasible_prefix(&[0, 0, 0], &edge), [2, 1, 1]);
    let halves = [std::vec![c(1, h), c(1, h)], std::vec![c(0, max)]];
    assert_eq!(greatest_feasible_prefix(&[1, 0], &halves), [2, 1]);
}
