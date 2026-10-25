//! Reference rules for the property and state-machine tests, written separately from
//! `rtgs-core` so that a bug there cannot hide a bug in the contract.
use std::vec::Vec;

use proptest::test_runner::{Config, RngSeed};

/// The settings `make test` runs with: a pinned seed and `cases` cases. To explore
/// further, set `PROPTEST_RNG_SEED` and `PROPTEST_CASES`, which win over these.
pub fn config(cases: u32) -> Config {
    let mut settings = Config::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        settings.cases = cases;
    }
    if std::env::var_os("PROPTEST_RNG_SEED").is_none() {
        settings.rng_seed = RngSeed::Fixed(0x5e771e);
    }
    // A pinned seed reproduces any failure, so there is nothing to persist.
    settings.failure_persistence = None;
    settings
}

/// Spec O's greatest feasible prefix k* by R4's descent (§4.5): start from every whole
/// queue and, while some account would end negative, drop that account's last candidate.
/// `queues[a]` holds `(to, amount)` in `≺` order, and balances are non-negative.
pub fn greatest_feasible_prefix(balances: &[i128], queues: &[Vec<(usize, i128)>]) -> Vec<usize> {
    let mut prefix: Vec<usize> = queues.iter().map(Vec::len).collect();
    // An account that sends nothing is never in violation, so a violator has prefix[account] > 0.
    while let Some(account) =
        (0..balances.len()).find(|account| !covered(balances, queues, &prefix, *account))
    {
        prefix[account] -= 1;
    }
    prefix
}

/// F1 for `account` with `lim` = 0: its outflow is at most its balance plus its inflow,
/// over the integers (§4.5). Queued sums can exceed `i128` (SC-A01-07), so this is
/// decided exactly, never by an overflow.
fn covered(
    balances: &[i128],
    queues: &[Vec<(usize, i128)>],
    prefix: &[usize],
    account: usize,
) -> bool {
    let outflow = queues[account][..prefix[account]]
        .iter()
        .map(|(_, amount)| *amount);
    let inflow = queues
        .iter()
        .enumerate()
        .flat_map(|(sender, queue)| &queue[..prefix[sender]])
        .filter(|(to, _)| *to == account)
        .map(|(_, amount)| *amount);
    net_is_non_negative(balances[account], inflow, outflow)
}

/// Whether `balance + Σ inflow − Σ outflow ≥ 0`, decided exactly. The sums can exceed
/// `i128`, so each amount is split into 64-bit halves, whose sums cannot overflow. SC-P-09
/// checks it against F1 decided another way, as 256-bit sums (`checks::feasible`).
fn net_is_non_negative(
    balance: i128,
    inflow: impl Iterator<Item = i128>,
    outflow: impl Iterator<Item = i128>,
) -> bool {
    const HALF: i128 = 1 << 64;
    let (mut hi, mut lo) = (balance.div_euclid(HALF), balance.rem_euclid(HALF));
    for amount in inflow {
        hi += amount.div_euclid(HALF);
        lo += amount.rem_euclid(HALF);
    }
    for amount in outflow {
        hi -= amount.div_euclid(HALF);
        lo -= amount.rem_euclid(HALF);
    }
    // The net is `hi · 2^64 + lo`; with `lo` carried into [0, 2^64), its sign is `hi`'s.
    hi + lo.div_euclid(HALF) >= 0
}

/// Every prefix vector of `queues`, from all zeros to every whole queue.
fn all_prefixes(queues: &[Vec<(usize, i128)>]) -> Vec<Vec<usize>> {
    queues.iter().fold(std::vec![Vec::new()], |acc, queue| {
        acc.iter()
            .flat_map(|prefix| {
                (0..=queue.len()).map(move |n| {
                    let mut extended = prefix.clone();
                    extended.push(n);
                    extended
                })
            })
            .collect()
    })
}

/// R4 and F1 (ADR-0010): the descent above, which judges SC-P-01 and SC-P-02, returns the
/// join of every feasible prefix vector, found by enumeration, and that join is feasible.
/// Amounts and balances reach `i128::MAX` and its half, straddle 2^64, have low halves
/// around 2^63 and are drawn anywhere up to `i128::MAX`, so F1 is checked where the sums
/// exceed `i128` and wherever the 64-bit split puts a value.
/// The enumeration decides F1 its own way, as 256-bit sums, so that a mistake in the
/// descent's 64-bit split doesn't also judge it.
mod checks {
    use super::*;
    use proptest::prelude::*;

    /// `n` balances, small or at the `i128` edges, adding up to at most `i128::MAX`, as in
    /// the contract (S1): each is cut to what the balances before it leave.
    fn balances(n: usize) -> impl Strategy<Value = Vec<i128>> {
        let balance = prop_oneof![
            4 => 0i128..=60,
            1 => Just((1i128 << 63) - 1),
            1 => Just(1i128 << 63),
            1 => 0i128..=i128::MAX,
            1 => Just((1i128 << 64) - 1),
            1 => Just(1i128 << 64),
            1 => Just(i128::MAX / 2),
            1 => Just(i128::MAX / 2 + 1),
            1 => (i128::MAX - 60)..=i128::MAX,
        ];
        prop::collection::vec(balance, n).prop_map(|drawn| {
            let mut headroom = i128::MAX;
            drawn
                .into_iter()
                .map(|balance| {
                    let kept = balance.min(headroom);
                    headroom -= kept;
                    kept
                })
                .collect()
        })
    }

    fn instance() -> impl Strategy<Value = (Vec<i128>, Vec<Vec<(usize, i128)>>)> {
        let amount = prop_oneof![
            6 => 1i128..=80,
            1 => Just((1i128 << 63) - 1),
            1 => Just(1i128 << 63),
            1 => Just((1i128 << 64) - 1),
            1 => Just(1i128 << 64),
            1 => 1i128..=i128::MAX,
            1 => Just(i128::MAX),
            1 => Just(i128::MAX / 2 + 1),
        ];
        (2usize..=4).prop_flat_map(move |n| {
            let candidate = (0..n - 1, amount.clone());
            (
                balances(n),
                prop::collection::vec(prop::collection::vec(candidate, 0..=3), n),
            )
                .prop_map(move |(balances, raw)| {
                    // `to` is drawn among the other accounts: shift past the sender.
                    let queues = raw
                        .into_iter()
                        .enumerate()
                        .map(|(sender, queue)| {
                            queue
                                .into_iter()
                                .map(|(to, amount)| {
                                    (if to >= sender { to + 1 } else { to }, amount)
                                })
                                .collect()
                        })
                        .collect();
                    (balances, queues)
                })
        })
    }

    /// F1 with `lim` = 0 for every account: `balance + Σ inflow ≥ Σ outflow`, each side a
    /// 256-bit unsigned sum held as a `(carries, low)` pair of `u128`s.
    fn feasible(balances: &[i128], queues: &[Vec<(usize, i128)>], prefix: &[usize]) -> bool {
        let wide_sum = |values: &mut dyn Iterator<Item = i128>| {
            values.fold((0u128, 0u128), |(carries, low), value| {
                let value = u128::try_from(value).expect("balances and amounts are non-negative");
                let (low, carried) = low.overflowing_add(value);
                (carries + u128::from(carried), low)
            })
        };
        (0..balances.len()).all(|account| {
            let mut credits = core::iter::once(balances[account]).chain(
                queues
                    .iter()
                    .enumerate()
                    .flat_map(|(sender, queue)| &queue[..prefix[sender]])
                    .filter(|(to, _)| *to == account)
                    .map(|(_, amount)| *amount),
            );
            let mut debits = queues[account][..prefix[account]]
                .iter()
                .map(|(_, amount)| *amount);
            wide_sum(&mut credits) >= wide_sum(&mut debits)
        })
    }

    proptest! {
        #![proptest_config(config(256))]

        /// R4, F1 at the `i128` limit: the descent is the join of every feasible prefix
        /// (ADR-0010).
        #[test]
        fn the_reference_descent_is_the_greatest_feasible_prefix((balances, queues) in instance()) {
            let descent = greatest_feasible_prefix(&balances, &queues);
            let feasible: Vec<Vec<usize>> = all_prefixes(&queues)
                .into_iter()
                .filter(|prefix| feasible(&balances, &queues, prefix))
                .collect();
            let join: Vec<usize> = (0..balances.len())
                .map(|account| feasible.iter().map(|prefix| prefix[account]).max().unwrap_or(0))
                .collect();
            prop_assert!(feasible.contains(&join), "R4: the join {:?} is infeasible", join);
            prop_assert_eq!(descent, join);
        }
    }

    /// R7's witness (§4.10): the cycle A→B 15, B→C 20, C→A 25 with every balance 10 has
    /// k* = (1, 1, 1); dropping one candidate can cascade to nothing; and sums and balances
    /// beyond `i128` and 2^64 are decided exactly (SC-A03-11; F1, R5; ADR-0010).
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
        let (max, half) = (i128::MAX, i128::MAX / 2 + 1);
        let edge = [
            std::vec![(1, max), (2, max)],
            std::vec![(0, max)],
            std::vec![(0, max)],
        ];
        assert_eq!(greatest_feasible_prefix(&[0, 0, 0], &edge), [2, 1, 1]);
        let halves = [std::vec![(1, half), (1, half)], std::vec![(0, max)]];
        assert_eq!(greatest_feasible_prefix(&[1, 0], &halves), [2, 1]);
        // SC-A03-11's kernel instances: a balance of 2^64, and one whose inflow on top
        // exceeds `i128`.
        let two_to_the_64 = 1i128 << 64;
        let whole = [std::vec![(1, two_to_the_64)], std::vec![]];
        assert_eq!(
            greatest_feasible_prefix(&[two_to_the_64, 0], &whole),
            [1, 0]
        );
        let round_trip = [std::vec![(1, max)], std::vec![(0, max)]];
        assert_eq!(greatest_feasible_prefix(&[1, max - 1], &round_trip), [1, 1]);
    }
}
