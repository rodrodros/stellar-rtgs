//! The RTGS's pure settlement rules: covers, queue order and the greatest feasible prefix.
//!
//! This crate has no soroban-sdk dependency and no `Env`, so its rules can be tested
//! natively, property-tested and proved with Kani, which cannot compile the soroban-sdk
//! test host (C-ST-059). The settlement contract calls `covers`; it will call
//! `greatest_feasible_prefix` once it offsets (Flow 13). Both are implemented, with their
//! unit tests (below) and property tests (`props.rs`); see TESTING.md, "Property and
//! state-machine tests".
#![no_std]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;

/// One queued payment, as the prefix rule sees it: the account it credits and its amount.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Candidate {
    pub to: usize,
    pub amount: i128,
}

/// §4.5 `cov` with no credit line and no reservations (ADR-0011, ADR-0018): a payment is
/// covered if paying it leaves the sender's balance non-negative.
///
/// `bal − a ≥ 0` is written as `a ≤ bal`, which cannot overflow for any `i128` pair.
pub fn covers(balance: i128, amount: i128) -> bool {
    amount <= balance
}

/// Spec O's greatest feasible prefix k* (§4.5, R4; ADR-0010).
///
/// `balances[a]` is account `a`'s balance and `queues[a]` its candidates in `≺` order.
/// Returns `k`, where `k[a]` is how many of `a`'s first candidates the offset settles. A
/// prefix vector is feasible if every account ends non-negative (F1 with `lim` = 0).
///
/// Overflow: F1 is decided over the integers, never by an overflow. S1 bounds the
/// balances, but not the queued amounts: a bank can queue payments it can't cover
/// (SC-A01-07), so an account's incoming or outgoing sum can exceed `i128` while every
/// balance the offset leaves fits. Treating an overflowing sum as infeasible would miss
/// feasible prefixes and leave the queues gridlocked (SC-A03-11). So each balance and each
/// amount is split into its 64-bit halves, `value = high · 2^64 + low` with `low` in
/// [0, 2^64), and each account's net is kept as the two sums of its halves, which stay in
/// `i128` for fewer than 2^62 candidates in all.
///
/// The descent (R4): start from every candidate and, while some account is infeasible,
/// drop the last candidate of the lowest such account, as the Quint model's `kstar` does.
/// Each round drops one candidate, so it makes at most `Σ queues[a].len()` removals.
///
/// Expects what the contract guarantees: one balance and one queue per account (equal
/// lengths), every balance non-negative (S2), every amount positive (A1's guard) and every
/// `to` an index into `balances`.
///
/// # Panics
///
/// If those expectations fail: more queues than balances, or a `to` out of range, index
/// out of bounds, and a negative balance or a non-positive amount can leave a violator
/// with nothing to drop, so its prefix underflows.
pub fn greatest_feasible_prefix(balances: &[i128], queues: &[Vec<Candidate>]) -> Vec<usize> {
    let mut prefix: Vec<usize> = queues.iter().map(Vec::len).collect();
    // One pair of buffers for every round: the contract's allocator never frees.
    let mut high = vec![0_i128; balances.len()];
    let mut low = vec![0_i128; balances.len()];
    loop {
        for (account, &balance) in balances.iter().enumerate() {
            (high[account], low[account]) = split(balance);
        }
        for (payer, queue) in queues.iter().enumerate() {
            for candidate in &queue[..prefix[payer]] {
                let (amount_high, amount_low) = split(candidate.amount);
                high[payer] -= amount_high;
                low[payer] -= amount_low;
                high[candidate.to] += amount_high;
                low[candidate.to] += amount_low;
            }
        }
        // The net is `high · 2^64 + low`; with `low` carried into [0, 2^64), its sign is
        // `high`'s. With balances non-negative and amounts positive, an account that sends
        // nothing is never infeasible, so a violator has a candidate to drop.
        let violating =
            (0..prefix.len()).find(|&account| high[account] + low[account].div_euclid(HALF) < 0);
        match violating {
            Some(account) => prefix[account] -= 1,
            None => return prefix,
        }
    }
}

/// 2^64, where `greatest_feasible_prefix` splits an amount.
const HALF: i128 = 1 << 64;

/// `value` as `(high, low)`, with `value = high · 2^64 + low` and `low` in [0, 2^64).
fn split(value: i128) -> (i128, i128) {
    (value.div_euclid(HALF), value.rem_euclid(HALF))
}

#[cfg(test)]
mod props;

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn to(to: usize, amount: i128) -> Candidate {
        Candidate { to, amount }
    }

    /// §4.5 `cov` with `lim` = 0 and no reserves (ADR-0011, ADR-0018): exactly the
    /// balance is covered, one more is not, and an amount above a zero balance never is.
    #[test]
    fn covers_is_balance_minus_amount_at_least_zero() {
        assert!(covers(100, 100));
        assert!(covers(100, 1));
        assert!(!covers(100, 101));
        assert!(!covers(0, 1));
        assert!(covers(i128::MAX, i128::MAX));
    }

    /// Spec O (ADR-0010): k* over no accounts, or over accounts with empty queues, is all
    /// zeros.
    #[test]
    fn the_prefix_of_empty_queues_is_zero() {
        assert_eq!(greatest_feasible_prefix(&[], &[]), Vec::<usize>::new());
        assert_eq!(
            greatest_feasible_prefix(&[5, 0], &[vec![], vec![]]),
            vec![0, 0]
        );
    }

    /// R4, Spec O (ADR-0010): when every candidate fits, k* takes every queue whole.
    #[test]
    fn when_everything_fits_the_prefix_is_every_candidate() {
        let prefix = greatest_feasible_prefix(&[100, 0], &[vec![to(1, 40), to(1, 60)], vec![]]);
        assert_eq!(prefix, vec![2, 0]);
    }

    /// R7's witness (§4.10; ADR-0010): the cycle A→B 15, B→C 20, C→A 25 with every
    /// balance 10. No single payment is covered, yet k* = (1, 1, 1).
    #[test]
    fn r7_cycle_has_prefix_one_one_one() {
        let prefix = greatest_feasible_prefix(
            &[10, 10, 10],
            &[vec![to(1, 15)], vec![to(2, 20)], vec![to(0, 25)]],
        );
        assert_eq!(prefix, vec![1, 1, 1]);
    }

    /// F2 (ADR-0008, ADR-0010), on CPSS Box 4 with no counterparty (C-RT-045): after the
    /// 40 settles, balance 60 and the queue 70, 20, 30, 10. The 70 does not fit, and the
    /// prefix must start with it, so k* = 0.
    #[test]
    fn an_uncovered_first_candidate_blocks_the_whole_queue() {
        let prefix = greatest_feasible_prefix(
            &[60, 0],
            &[vec![to(1, 70), to(1, 20), to(1, 30), to(1, 10)], vec![]],
        );
        assert_eq!(prefix, vec![0, 0]);
    }

    /// R4's descent (ADR-0010): A's whole queue does not fit, so its last candidate is dropped, and
    /// the offset with B then fits: k* = (1, 1).
    #[test]
    fn the_descent_drops_the_last_candidate_of_a_violating_account() {
        let prefix =
            greatest_feasible_prefix(&[0, 0], &[vec![to(1, 50), to(1, 30)], vec![to(0, 50)]]);
        assert_eq!(prefix, vec![1, 1]);
    }

    /// R4's descent cascades (ADR-0010): dropping A's candidate takes B's inflow away, so B must
    /// drop too, and then C. Nothing is feasible.
    #[test]
    fn dropping_one_candidate_can_make_others_infeasible() {
        let prefix = greatest_feasible_prefix(
            &[0, 0, 0],
            &[vec![to(1, 30)], vec![to(2, 30)], vec![to(0, 20)]],
        );
        assert_eq!(prefix, vec![0, 0, 0]);
    }

    /// R4 (ADR-0010): k* is the join of the feasible prefixes, so it does not depend on the account
    /// order. Relabelling the accounts of a two-cycle with a dependent tail gives the
    /// same prefix lengths, relabelled.
    #[test]
    fn the_prefix_does_not_depend_on_the_account_order() {
        let forward = greatest_feasible_prefix(
            &[0, 5, 0],
            &[vec![to(1, 50)], vec![to(0, 50), to(2, 5)], vec![to(0, 99)]],
        );
        assert_eq!(forward, vec![1, 2, 0]);
        // Accounts 0 and 2 swapped.
        let swapped = greatest_feasible_prefix(
            &[0, 5, 0],
            &[vec![to(2, 99)], vec![to(2, 50), to(0, 5)], vec![to(1, 50)]],
        );
        assert_eq!(swapped, vec![0, 2, 1]);
    }

    /// F2 and F6 (ADR-0008, ADR-0010): the prefix never skips a candidate. B→A 50 would fit with A's second
    /// payment, but A's first, 100, does not fit, so k* = (0, 0).
    #[test]
    fn the_prefix_never_skips_an_earlier_candidate() {
        let prefix =
            greatest_feasible_prefix(&[0, 0], &[vec![to(1, 100), to(1, 50)], vec![to(0, 50)]]);
        assert_eq!(prefix, vec![0, 0]);
    }

    /// SC-A03-11. F1 and R4 with balances of 2^64 and beyond (S1, S2; ADR-0010): the rule
    /// splits a balance into 64-bit halves like an amount, and both halves count. A holds
    /// 2^64 and pays B 2^64, so k* = (1, 0). And with A at 1 and B at `i128::MAX − 1`, A
    /// pays B `i128::MAX` and B pays it back: B's balance plus its inflow exceeds `i128`,
    /// yet both settle, k* = (1, 1).
    #[test]
    fn balances_beyond_two_to_the_sixty_four_are_decided_exactly() {
        let two_to_the_64 = 1_i128 << 64;
        let prefix =
            greatest_feasible_prefix(&[two_to_the_64, 0], &[vec![to(1, two_to_the_64)], vec![]]);
        assert_eq!(prefix, vec![1, 0]);
        let max = i128::MAX;
        let prefix = greatest_feasible_prefix(&[1, max - 1], &[vec![to(1, max)], vec![to(0, max)]]);
        assert_eq!(prefix, vec![1, 1]);
    }

    /// F1 and R4 at the `i128` limit (ADR-0010): B's two candidates of `i128::MAX` add up
    /// to more than `i128` holds, without a panic. Against A's one `i128::MAX`, B would end
    /// at −`i128::MAX`, so B's prefix is cut back to one, and k* = (1, 1).
    #[test]
    fn a_prefix_that_leaves_an_account_negative_is_cut_back_at_the_i128_limit() {
        let prefix = greatest_feasible_prefix(
            &[0, 0],
            &[
                vec![to(1, i128::MAX)],
                vec![to(0, i128::MAX), to(0, i128::MAX)],
            ],
        );
        assert_eq!(prefix, vec![1, 1]);
    }
}
