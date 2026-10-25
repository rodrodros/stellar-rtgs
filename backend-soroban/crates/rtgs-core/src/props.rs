//! Property tests for the pure rules (TESTING.md, "Property and state-machine tests").
//!
//! The oracle enumerates every prefix vector of small instances and keeps the feasible
//! ones (F1 with `lim` = 0, §4.5), decided over the integers: queued sums can exceed
//! `i128`, and an overflow must never decide feasibility. Then the feasible vectors are
//! closed under join (R4). The rule is checked at amounts and balances up to the `i128`
//! edges: k* is the greatest feasible prefix there (SC-P-08), and R5 holds there too.
extern crate std;

use alloc::vec::Vec;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngSeed};

use super::{covers, greatest_feasible_prefix, Candidate};

/// The settings `make test` runs with: a pinned seed and `cases` cases. To explore
/// further, set `PROPTEST_RNG_SEED` and `PROPTEST_CASES`, which win over these.
fn config(cases: u32) -> Config {
    let mut config = Config::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = cases;
    }
    if std::env::var_os("PROPTEST_RNG_SEED").is_none() {
        config.rng_seed = RngSeed::Fixed(0x5e771e);
    }
    // A pinned seed reproduces any failure, so there is nothing to persist.
    config.failure_persistence = None;
    config
}

/// An instance of the prefix rule: every account's balance and its candidates in `≺`
/// order.
#[derive(Clone, Debug)]
struct Instance {
    balances: Vec<i128>,
    queues: Vec<Vec<Candidate>>,
}

/// 2 to 4 accounts, each with up to 3 candidates to other accounts. Payments are
/// positive (S11) and balances small and non-negative (S2 with `lim` = 0).
fn instance_with(amount: BoxedStrategy<i128>) -> impl Strategy<Value = Instance> {
    instance_with_balances(amount, (0i128..=60).boxed())
}

/// As `instance_with`, with balances drawn from `balance`. The balances add up to at most
/// `i128::MAX`, as in the contract (S1), so every balance a feasible offset leaves fits:
/// each is cut to what the balances before it leave, so no draw is rejected and the sum
/// often meets `i128::MAX` exactly.
fn instance_with_balances(
    amount: BoxedStrategy<i128>,
    balance: BoxedStrategy<i128>,
) -> impl Strategy<Value = Instance> {
    (2usize..=4).prop_flat_map(move |n| {
        let candidate = (1..n, amount.clone());
        (
            prop::collection::vec(balance.clone(), n).prop_map(|drawn| {
                let mut headroom = i128::MAX;
                drawn
                    .into_iter()
                    .map(|balance| {
                        let kept = balance.min(headroom);
                        headroom -= kept;
                        kept
                    })
                    .collect::<Vec<i128>>()
            }),
            prop::collection::vec(prop::collection::vec(candidate, 0..=3), n),
        )
            .prop_map(move |(balances, raw)| Instance {
                balances,
                queues: raw
                    .into_iter()
                    .enumerate()
                    .map(|(account, queue)| {
                        queue
                            .into_iter()
                            .map(|(offset, amount)| Candidate {
                                to: (account + offset) % n,
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

/// Amounts on both sides of 2^64, where the rule splits them, with a low half around
/// 2^63, anywhere up to `i128::MAX` and at the `i128` limit, as well as small ones.
fn edgy() -> BoxedStrategy<i128> {
    prop_oneof![
        3 => 1i128..=60,
        1 => Just((1i128 << 63) - 1),
        1 => Just(1i128 << 63),
        1 => 1i128..=i128::MAX,
        1 => Just((1i128 << 64) - 1),
        1 => Just(1i128 << 64),
        1 => Just(i128::MAX),
        1 => Just(i128::MAX / 2 + 1),
        1 => (i128::MAX - 60)..=i128::MAX,
    ]
    .boxed()
}

/// Balances on both sides of 2^64, where the rule splits them, with a low half around
/// 2^63, and anywhere up to `i128::MAX`, as well as small ones.
fn edgy_balances() -> BoxedStrategy<i128> {
    prop_oneof![
        3 => 0i128..=60,
        1 => Just((1i128 << 63) - 1),
        1 => Just(1i128 << 63),
        1 => 0i128..=i128::MAX,
        1 => Just((1i128 << 64) - 1),
        1 => Just(1i128 << 64),
        1 => Just(i128::MAX / 2),
        1 => Just(i128::MAX / 2 + 1),
        1 => (i128::MAX - 60)..=i128::MAX,
    ]
    .boxed()
}

/// F1 with `lim` = 0: every account ends non-negative when the first `k[a]` candidates
/// of every account `a` settle, i.e. its outflow is at most its balance plus its inflow,
/// over the integers.
fn feasible(instance: &Instance, prefix: &[usize]) -> bool {
    (0..instance.balances.len()).all(|account| {
        let (credits, debits) = wide_flows(instance, prefix, account);
        credits >= debits
    })
}

/// A 256-bit unsigned sum, `carries · 2^128 + low`, as a `(carries, low)` pair of
/// `u128`s. The tuple order compares two of them exactly.
type Wide = (u128, u128);

/// `account`'s balance plus its inflow, and its outflow, when the first `k[a]` candidates
/// of every `a` settle, each as a 256-bit sum. The rule splits amounts into 64-bit halves;
/// this oracle sums them another way, so that the two don't share a mistake.
fn wide_flows(instance: &Instance, prefix: &[usize], account: usize) -> (Wide, Wide) {
    let wide_sum = |values: &mut dyn Iterator<Item = i128>| {
        values.fold((0u128, 0u128), |(carries, low), value| {
            let value = u128::try_from(value).expect("balances and amounts are non-negative");
            let (low, carried) = low.overflowing_add(value);
            (carries + u128::from(carried), low)
        })
    };
    let mut credits = core::iter::once(instance.balances[account]).chain(
        instance
            .queues
            .iter()
            .enumerate()
            .flat_map(|(payer, queue)| &queue[..prefix[payer]])
            .filter(|candidate| candidate.to == account)
            .map(|candidate| candidate.amount),
    );
    let mut debits = instance.queues[account][..prefix[account]]
        .iter()
        .map(|candidate| candidate.amount);
    (wide_sum(&mut credits), wide_sum(&mut debits))
}

/// The balances after the first `k[a]` candidates of every `a` settle, each booked as one
/// exact net, so the sums may exceed `i128`. Expects `prefix` feasible: by S1 every end
/// balance then fits in `i128`, and it panics if one does not.
fn end_balances(instance: &Instance, prefix: &[usize]) -> Vec<i128> {
    (0..instance.balances.len())
        .map(|account| {
            let (credits, debits) = wide_flows(instance, prefix, account);
            let (low, borrowed) = credits.1.overflowing_sub(debits.1);
            let carries = credits.0 - debits.0 - u128::from(borrowed);
            assert_eq!(
                carries, 0,
                "S1: account {account}'s end balance fits in i128"
            );
            i128::try_from(low).expect("S1: an end balance fits in i128")
        })
        .collect()
}

/// Every prefix vector of the instance.
fn all_prefixes(instance: &Instance) -> Vec<Vec<usize>> {
    let mut all = alloc::vec![Vec::new()];
    for queue in &instance.queues {
        all = all
            .into_iter()
            .flat_map(|prefix| {
                (0..=queue.len()).map(move |len| {
                    let mut prefix = prefix.clone();
                    prefix.push(len);
                    prefix
                })
            })
            .collect();
    }
    all
}

fn le(left: &[usize], right: &[usize]) -> bool {
    left.iter().zip(right).all(|(x, y)| x <= y)
}

/// Strict FIFO gross processing (A2 only): settle any account's covered head until none
/// is covered. Its result is `k_seq` (§4.10, R6).
fn gross_only(instance: &Instance) -> Vec<usize> {
    let mut balances = instance.balances.clone();
    let mut prefix = alloc::vec![0usize; balances.len()];
    loop {
        let mut progressed = false;
        for (account, queue) in instance.queues.iter().enumerate() {
            while let Some(candidate) = queue.get(prefix[account]) {
                if balances[account] < candidate.amount {
                    break;
                }
                balances[account] -= candidate.amount;
                balances[candidate.to] += candidate.amount;
                prefix[account] += 1;
                progressed = true;
            }
        }
        if !progressed {
            return prefix;
        }
    }
}

/// The instance left after the first `k[a]` candidates of every `a` settle.
fn after(instance: &Instance, prefix: &[usize]) -> Instance {
    Instance {
        balances: end_balances(instance, prefix),
        queues: instance
            .queues
            .iter()
            .zip(prefix)
            .map(|(queue, len)| queue[*len..].to_vec())
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
        (balance, amount) in any::<i128>().prop_flat_map(|balance| {
            let near = prop_oneof![
                Just(balance),
                Just(balance.saturating_add(1)),
                Just(balance.saturating_sub(1)),
            ];
            (Just(balance), prop_oneof![1 => near, 1 => any::<i128>()])
        })
    ) {
        prop_assert_eq!(covers(balance, amount), balance >= amount);
    }

    /// R4, S10: k* has one entry per account and never exceeds an account's queue (§4.5,
    /// Spec O; ADR-0010).
    #[test]
    fn the_prefix_is_within_every_queue(instance in instance_with(small())) {
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        prop_assert_eq!(prefix.len(), instance.balances.len());
        for (account, queue) in instance.queues.iter().enumerate() {
            prop_assert!(
                prefix[account] <= queue.len(),
                "k[{}] = {} > {}", account, prefix[account], queue.len()
            );
        }
    }

    /// The prefix the offset settles is feasible: F1 with `lim` = 0 (S10, S2; ADR-0010).
    #[test]
    fn the_prefix_is_feasible(instance in instance_with(small())) {
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        prop_assert!(feasible(&instance, &prefix), "infeasible k = {:?}", prefix);
    }

    /// R4: the feasible prefix vectors are closed under join, so a greatest one
    /// exists and is unique, and the rule returns it. Checked against every prefix vector
    /// (ADR-0010).
    #[test]
    fn the_prefix_is_the_greatest_feasible_one(instance in instance_with(small())) {
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        let feasible: Vec<Vec<usize>> = all_prefixes(&instance)
            .into_iter()
            .filter(|vector| feasible(&instance, vector))
            .collect();
        let join: Vec<usize> = (0..instance.balances.len())
            .map(|account| feasible.iter().map(|vector| vector[account]).max().unwrap_or(0))
            .collect();
        prop_assert!(feasible.contains(&join), "R4: the join {:?} is infeasible", join);
        for vector in &feasible {
            prop_assert!(le(vector, &prefix), "feasible {:?} is not below k* {:?}", vector, prefix);
        }
        prop_assert_eq!(prefix, join);
    }

    /// R4: k* is defined by the accounts, not their order. Relabelling the accounts
    /// relabels k* the same way (ADR-0010).
    #[test]
    fn the_prefix_does_not_depend_on_the_account_order(
        (instance, perm) in instance_with(small()).prop_flat_map(|instance| {
            let n = instance.balances.len();
            (Just(instance), Just((0..n).collect::<Vec<usize>>()).prop_shuffle())
        })
    ) {
        // Account `a` becomes account `perm[a]`.
        let n = instance.balances.len();
        let mut balances = alloc::vec![0; n];
        let mut queues = alloc::vec![Vec::new(); n];
        for account in 0..n {
            balances[perm[account]] = instance.balances[account];
            queues[perm[account]] = instance.queues[account]
                .iter()
                .map(|candidate| Candidate { to: perm[candidate.to], amount: candidate.amount })
                .collect();
        }
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        let relabelled = greatest_feasible_prefix(&balances, &queues);
        for account in 0..n {
            prop_assert_eq!(relabelled[perm[account]], prefix[account], "account {}", account);
        }
    }

    /// R4: more liquidity never settles less. Raising one balance gives a k* at least as
    /// great in every account (ADR-0010).
    #[test]
    fn more_liquidity_never_shrinks_the_prefix(
        instance in instance_with(small()),
        who in any::<prop::sample::Index>(),
        extra in 0i128..=60,
    ) {
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        let mut richer = instance.clone();
        richer.balances[who.index(instance.balances.len())] += extra;
        let k2 = greatest_feasible_prefix(&richer.balances, &richer.queues);
        prop_assert!(le(&prefix, &k2), "{:?} then {:?}", prefix, k2);
    }

    /// R6: strict FIFO gross processing alone stops at `k_seq ≤ k*`, so the offset never
    /// settles less than gross processing would (R7 shows it can settle more; ADR-0010).
    #[test]
    fn gross_processing_never_beats_the_offset(instance in instance_with(small())) {
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        let k_seq = gross_only(&instance);
        prop_assert!(le(&k_seq, &prefix), "k_seq {:?} > k* {:?}", k_seq, prefix);
    }

    /// R5 and S23: after the offset of k*, the greatest feasible prefix of what is left
    /// is zero, so the queues are at rest until something external happens. Half the
    /// instances have amounts and balances at the `i128` edges (ADR-0010).
    #[test]
    fn after_the_offset_nothing_more_is_feasible(
        instance in prop_oneof![
            instance_with(small()).boxed(),
            instance_with_balances(edgy(), edgy_balances()).boxed(),
        ]
    ) {
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        prop_assert!(feasible(&instance, &prefix), "infeasible k = {:?}", prefix);
        let rest = after(&instance, &prefix);
        let k2 = greatest_feasible_prefix(&rest.balances, &rest.queues);
        prop_assert!(k2.iter().all(|x| *x == 0), "R5: k* of the rest is {:?}", k2);
        // Judged by the oracle too, so that a rule that under-settles on both can't pass.
        for vector in all_prefixes(&rest).iter().filter(|vector| feasible(&rest, vector)) {
            prop_assert!(
                vector.iter().all(|x| *x == 0),
                "R5: {:?} is feasible after the offset", vector
            );
        }
    }

    /// F2: the prefix of an account whose first candidate exceeds its balance plus every
    /// payment it could receive is zero, so nothing behind that candidate overtakes it
    /// (S7, ADR-0008).
    #[test]
    fn a_candidate_no_inflow_can_cover_blocks_its_queue(instance in instance_with(small())) {
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        for (account, queue) in instance.queues.iter().enumerate() {
            let Some(head) = queue.first() else { continue };
            let max_in: i128 = instance
                .queues
                .iter()
                .flatten()
                .filter(|candidate| candidate.to == account)
                .map(|candidate| candidate.amount)
                .sum();
            if head.amount > instance.balances[account] + max_in {
                prop_assert_eq!(prefix[account], 0, "account {} overtook its head", account);
            }
        }
    }

    /// Amounts and balances at the `i128` limit: the rule never panics, decides F1 exactly
    /// although the sums exceed `i128`, and returns the greatest feasible prefix (S2, S10,
    /// R4; ADR-0010).
    #[test]
    fn sums_beyond_i128_are_decided_exactly_not_a_panic(
        instance in instance_with_balances(edgy(), edgy_balances())
    ) {
        let prefix = greatest_feasible_prefix(&instance.balances, &instance.queues);
        prop_assert!(feasible(&instance, &prefix), "infeasible k = {:?}", prefix);
        for vector in all_prefixes(&instance).iter().filter(|vector| feasible(&instance, vector)) {
            prop_assert!(le(vector, &prefix), "feasible {:?} is not below k* {:?}", vector, prefix);
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
    let candidate = |to, amount| Candidate { to, amount };
    let (max, half) = (i128::MAX, i128::MAX / 2 + 1);
    let edge = [
        std::vec![candidate(1, max), candidate(2, max)],
        std::vec![candidate(0, max)],
        std::vec![candidate(0, max)],
    ];
    assert_eq!(greatest_feasible_prefix(&[0, 0, 0], &edge), [2, 1, 1]);
    let halves = [
        std::vec![candidate(1, half), candidate(1, half)],
        std::vec![candidate(0, max)],
    ];
    assert_eq!(greatest_feasible_prefix(&[1, 0], &halves), [2, 1]);
}
