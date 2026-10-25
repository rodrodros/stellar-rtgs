//! Reference rules for the property and state-machine tests, written independently of
//! `rtgs-core` so that a bug there cannot hide a bug in the contract.
use std::vec::Vec;

use proptest::test_runner::{Config, RngSeed};

/// The settings `make test` runs with: a pinned seed and `cases` cases. To explore
/// further, set `PROPTEST_RNG_SEED` and `PROPTEST_CASES`, which win over these.
pub fn config(cases: u32) -> Config {
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

/// Spec O's greatest feasible prefix k* by R4's descent (§4.5): start from every whole
/// queue and, while some account would end negative, drop that account's last candidate.
/// `queues[a]` holds `(to, amount)` in `≺` order, and balances are non-negative.
pub fn greatest_feasible_prefix(balances: &[i128], queues: &[Vec<(usize, i128)>]) -> Vec<usize> {
    let mut k: Vec<usize> = queues.iter().map(Vec::len).collect();
    // An account that sends nothing is never in violation, so a violator has k[a] > 0.
    while let Some(a) = (0..balances.len()).find(|a| !covered(balances, queues, &k, *a)) {
        k[a] -= 1;
    }
    k
}

/// F1 for account `a` with `lim` = 0: its outflow is at most its balance plus its inflow,
/// over the integers (§4.5). Queued sums can exceed `i128` (SC-A01-07), so this is
/// decided exactly, never by an overflow.
fn covered(balances: &[i128], queues: &[Vec<(usize, i128)>], k: &[usize], a: usize) -> bool {
    let outflow = queues[a][..k[a]].iter().map(|(_, amount)| *amount);
    let inflow = queues
        .iter()
        .enumerate()
        .flat_map(|(p, q)| &q[..k[p]])
        .filter(|(to, _)| *to == a)
        .map(|(_, amount)| *amount);
    net_is_non_negative(balances[a], inflow, outflow)
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

/// Every prefix vector of `queues`, from all zeros to every whole queue.
fn all_prefixes(queues: &[Vec<(usize, i128)>]) -> Vec<Vec<usize>> {
    queues.iter().fold(std::vec![Vec::new()], |acc, q| {
        acc.iter()
            .flat_map(|p| {
                (0..=q.len()).map(move |n| {
                    let mut p = p.clone();
                    p.push(n);
                    p
                })
            })
            .collect()
    })
}

/// R4 and F1 (ADR-0010): the descent above, which judges SC-P-01 and SC-P-02, returns the
/// join of every feasible prefix vector, found by enumeration, and that join is feasible.
/// Amounts reach `i128::MAX` and its half, so F1 is checked where the sums exceed `i128`.
mod checks {
    use super::*;
    use proptest::prelude::*;

    fn instance() -> impl Strategy<Value = (Vec<i128>, Vec<Vec<(usize, i128)>>)> {
        let amount =
            prop_oneof![4 => 1i128..=80, 1 => Just(i128::MAX), 1 => Just(i128::MAX / 2 + 1)];
        (2usize..=4).prop_flat_map(move |n| {
            let candidate = (0..n - 1, amount.clone());
            (
                prop::collection::vec(0i128..=60, n),
                prop::collection::vec(prop::collection::vec(candidate, 0..=3), n),
            )
                .prop_map(move |(balances, raw)| {
                    // `to` is drawn among the other accounts: shift past the sender.
                    let queues = raw
                        .into_iter()
                        .enumerate()
                        .map(|(a, q)| {
                            q.into_iter()
                                .map(|(to, amount)| (if to >= a { to + 1 } else { to }, amount))
                                .collect()
                        })
                        .collect();
                    (balances, queues)
                })
        })
    }

    fn feasible(balances: &[i128], queues: &[Vec<(usize, i128)>], k: &[usize]) -> bool {
        (0..balances.len()).all(|a| covered(balances, queues, k, a))
    }

    proptest! {
        #![proptest_config(config(256))]

        /// R4, F1 at the `i128` limit: the descent is the join of every feasible prefix
        /// (ADR-0010).
        #[test]
        fn the_reference_descent_is_the_greatest_feasible_prefix((balances, queues) in instance()) {
            let k = greatest_feasible_prefix(&balances, &queues);
            let feasible: Vec<Vec<usize>> = all_prefixes(&queues)
                .into_iter()
                .filter(|p| feasible(&balances, &queues, p))
                .collect();
            let join: Vec<usize> = (0..balances.len())
                .map(|a| feasible.iter().map(|p| p[a]).max().unwrap_or(0))
                .collect();
            prop_assert!(feasible.contains(&join), "R4: the join {:?} is infeasible", join);
            prop_assert_eq!(k, join);
        }
    }

    /// R7's witness (§4.10): the cycle A→B 15, B→C 20, C→A 25 with every balance 10 has
    /// k* = (1, 1, 1); dropping one candidate can cascade to nothing; and sums beyond
    /// `i128` are decided exactly (SC-A03-11; F1, R5; ADR-0010).
    #[test]
    fn the_reference_descent_resolves_r7_and_cascades() {
        let cycle = [std::vec![(1, 15)], std::vec![(2, 20)], std::vec![(0, 25)]];
        assert_eq!(greatest_feasible_prefix(&[10, 10, 10], &cycle), [1, 1, 1]);
        let chain = [
            std::vec![(1, 10)],
            std::vec![(2, 10)],
            std::vec![(0, 5), (1, 1)],
        ];
        assert_eq!(greatest_feasible_prefix(&[0, 0, 4], &chain), [0, 0, 0]);
        // SC-A03-11: sums beyond `i128` are decided exactly.
        let (max, h) = (i128::MAX, i128::MAX / 2 + 1);
        let edge = [
            std::vec![(1, max), (2, max)],
            std::vec![(0, max)],
            std::vec![(0, max)],
        ];
        assert_eq!(greatest_feasible_prefix(&[0, 0, 0], &edge), [2, 1, 1]);
        let halves = [std::vec![(1, h), (1, h)], std::vec![(0, max)]];
        assert_eq!(greatest_feasible_prefix(&[1, 0], &halves), [2, 1]);
    }
}
