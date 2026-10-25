//! Storage lifetime and cost: what the ledger charges and keeps, not what the model sees.
//!
//! - **TTL.** Every entry point extends each entry it writes to about 30 days, so nothing
//!   the contract needs is archived while the RTGS runs (handbook 06: extend every entry).
//!   The constructor doesn't: a new instance starts at the network's minimum persistent
//!   TTL (C-SC-045), and the first entry point that writes extends it. The tests
//!   read the live-until ledger of every entry the contract owns from a ledger snapshot,
//!   whatever its key, so an entry added while implementing is held to the rule without
//!   a test naming it. The test host restores archived entries by itself (C-HB-131), so
//!   what happens after expiry belongs to the integration layer.
//! - **Cost.** ADR-0010 caps the queue so that one transaction can settle an offset over
//!   every queued payment (Spec O ranges over all of them; C-SC-204 puts the ceiling at
//!   about 66 payments). The test registers the contract from its Wasm, since a native
//!   contract skips VM metering (C-HB-042), and runs that offset at the cap.
use soroban_sdk::{
    testutils::Ledger as _,
    xdr::{LedgerKey, ScAddress},
};

use crate::tests::support::{default_config, Setup};
use crate::*;

const NORMAL: Priority = Priority::Normal;

/// Every ledger entry this contract owns (its instance and its own data), with the
/// ledger it lives until.
fn our_entries(setup: &Setup) -> std::vec::Vec<(LedgerKey, u32)> {
    let ours = ScAddress::from(&setup.contract);
    setup
        .env
        .to_ledger_snapshot()
        .ledger_entries
        .iter()
        .filter_map(|(key, (_, live_until))| match key.as_ref() {
            LedgerKey::ContractData(data) if data.contract == ours => Some((
                (**key).clone(),
                live_until.expect("contract data has a TTL"),
            )),
            _ => None,
        })
        .collect()
}

/// Asserts that every entry the contract owns lives until exactly `until`.
fn assert_every_entry_lives_until(setup: &Setup, until: u32) {
    let entries = our_entries(setup);
    assert!(!entries.is_empty());
    for (key, live_until) in entries {
        assert_eq!(live_until, until, "entry {key:?}");
    }
}

/// The instance and the bank's balance written by a deposit live `BUMP_AMOUNT` ledgers
/// (about 30 days) from the ledger of the deposit.
#[test]
fn a_deposit_extends_the_instance_and_the_balance_to_thirty_days() {
    let setup = Setup::new(2, 1_000);
    setup.env.ledger().set_sequence_number(1_000);

    setup.client().deposit(setup.bank(0), &600);

    assert_every_entry_lives_until(&setup, 1_000 + BUMP_AMOUNT);
}

/// An entry is extended again once its remaining TTL falls below `BUMP_THRESHOLD`, and
/// not before, so a busy entry is not rewritten on every call.
#[test]
fn an_entry_is_extended_again_only_below_the_threshold() {
    let setup = Setup::new(1, 1_000);
    let client = setup.client();
    setup.env.ledger().set_sequence_number(1_000);
    client.deposit(setup.bank(0), &100);

    // One ledger later the TTL is still above the threshold: unchanged.
    setup.env.ledger().set_sequence_number(1_001);
    client.deposit(setup.bank(0), &100);
    assert_every_entry_lives_until(&setup, 1_000 + BUMP_AMOUNT);

    // Once the remaining TTL is below the threshold, the next write extends it again.
    let later = 1_000 + (BUMP_AMOUNT - BUMP_THRESHOLD) + 1;
    setup.env.ledger().set_sequence_number(later);
    client.deposit(setup.bank(0), &100);
    assert_every_entry_lives_until(&setup, later + BUMP_AMOUNT);
}

/// Every entry point extends every entry it writes: payments, queues, credit, repos and
/// the instance alike. One ledger runs through every state-changing entry point, and
/// afterwards every entry the contract owns lives `BUMP_AMOUNT` ledgers from it.
#[test]
fn every_entry_point_extends_every_entry_it_writes() {
    let setup = Setup::new(3, 1_000);
    let client = setup.client();
    setup.env.ledger().set_sequence_number(5_000);
    setup.at(1_000);

    client.deposit(setup.bank(0), &500);
    client.withdraw(setup.bank(0), &100);
    client.submit(setup.bank(0), setup.bank(1), &50, &NORMAL);
    let revoked = client.submit(setup.bank(1), setup.bank(2), &900, &NORMAL);
    let moved = client.submit(setup.bank(1), setup.bank(2), &800, &NORMAL);
    let expired = client.submit(setup.bank(2), setup.bank(0), &700, &NORMAL);
    client.revoke(&revoked);
    client.reprioritise(&moved, &Priority::Urgent);
    client.set_collateral(setup.bank(2), &300);
    let repo = client.open_repo(setup.bank(2), &200);
    client.repay(setup.bank(2), &repo, &50);
    let overdue = client.open_repo(setup.bank(2), &50);
    setup.at(1_000
        + default_config()
            .expiry_secs
            .max(default_config().repo_term_secs)
        + 1);
    client.expire(&expired);
    client.convert_overdue(&overdue);

    assert_every_entry_lives_until(&setup, 5_000 + BUMP_AMOUNT);
    setup.assert_conserved();
}

/// The queue cap the cost test holds the contract to: C-SC-204's ceiling of about 66
/// payments per transaction, less a margin. Provisional: ADR-0010 sizes the cap from
/// ADR-0007's target (OQ-29, OQ-30). If the implementation cannot fit it, lower it here
/// and record why.
const QUEUE_CAP_UNDER_TEST: u32 = 64;

/// The Wasm that `make build` writes. `make test` builds it first.
const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/settlement.wasm"
);

/// ADR-0010's cap, priced: with the queue full, a deposit makes the whole of it feasible
/// at once, and one transaction settles every queued payment by offset (A3, S23) within
/// Stellar Mainnet's per-transaction limits.
///
/// The worst case for writes: `QUEUE_CAP_UNDER_TEST` banks in a ring, each paying the
/// next 10, bank 0 paying 11, every balance 0. The ring is 1 short at bank 0, so
/// everything queues. Bank 0's deposit of 1 makes the ring feasible, and the offset then
/// touches every bank, every queue and every payment.
///
/// The test host applies the Mainnet limits to every invocation (soroban-sdk's
/// `InvocationResourceLimits::mainnet`, a snapshot of 2026-07-10), so a call over them
/// fails. The explicit checks below name the limits that matter.
#[test]
fn an_offset_over_a_full_queue_fits_in_one_transaction() {
    let wasm =
        std::fs::read(WASM).unwrap_or_else(|err| panic!("{WASM}: {err}; run `make build` first"));
    let cap = QUEUE_CAP_UNDER_TEST;
    let setup = Setup::from_wasm(
        &wasm,
        cap as usize,
        Config {
            queue_cap: cap,
            ..default_config()
        },
    );
    let client = setup.client();
    let n = cap as usize;
    for i in 0..n {
        let amount = if i == 0 { 11 } else { 10 };
        client.submit(setup.bank(i), setup.bank((i + 1) % n), &amount, &NORMAL);
    }
    assert_eq!(client.queued_count(), cap);
    setup.mint(setup.bank(0), 1);

    client.deposit(setup.bank(0), &1);

    let used = setup.env.cost_estimate().resources();
    assert_eq!(client.queued_count(), 0);
    let mut expected = std::vec![0_i128; n];
    expected[1] = 1;
    assert_eq!(setup.balances(), expected);
    setup.assert_conserved();
    // Mainnet's per-transaction limits.
    assert!(used.write_entries <= 200, "{used:?}");
    assert!(used.instructions <= 400_000_000, "{used:?}");
    assert!(used.mem_bytes <= 41_943_040, "{used:?}");
    assert!(used.write_bytes <= 132_096, "{used:?}");
    assert!(used.contract_events_size_bytes <= 16_384, "{used:?}");
    assert!(
        used.disk_read_entries + used.memory_read_entries + used.write_entries <= 400,
        "{used:?}"
    );
}
