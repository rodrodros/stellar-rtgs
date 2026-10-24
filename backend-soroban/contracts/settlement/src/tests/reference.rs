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

/// F1 for account `a` with `lim` = 0: its outflow is at most its balance plus its inflow.
/// An outflow sum that overflows `i128` is infeasible; an inflow that overflows covers any
/// outflow.
fn covered(balances: &[i128], queues: &[Vec<(usize, i128)>], k: &[usize], a: usize) -> bool {
    let Some(out) = queues[a][..k[a]]
        .iter()
        .try_fold(0i128, |s, (_, amount)| s.checked_add(*amount))
    else {
        return false;
    };
    let inflow = queues
        .iter()
        .enumerate()
        .flat_map(|(p, q)| &q[..k[p]])
        .filter(|(to, _)| *to == a)
        .try_fold(0i128, |s, (_, amount)| s.checked_add(*amount));
    match inflow.and_then(|x| balances[a].checked_add(x)) {
        Some(available) => available >= out,
        None => true,
    }
}
