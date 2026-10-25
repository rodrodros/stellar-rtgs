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
//!   about 66 payments). The tests register the contract from its Wasm, since a native
//!   contract skips VM metering (C-HB-042), and run the eager closure over a full queue
//!   at the cap: offsets, gross cascades and covered submissions.
use soroban_sdk::{
    testutils::Ledger as _,
    xdr::{self, LedgerKey, Limits, ScAddress, WriteXdr},
    IntoVal, TryFromVal, Val,
};

use crate::tests::support::{default_config, Setup};
use crate::*;

const NORMAL: Priority = Priority::Normal;
const URGENT: Priority = Priority::Urgent;

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

/// The ledger key of the contract's instance.
fn instance_key(setup: &Setup) -> LedgerKey {
    LedgerKey::ContractData(xdr::LedgerKeyContractData {
        contract: ScAddress::from(&setup.contract),
        key: xdr::ScVal::LedgerKeyContractInstance,
        durability: xdr::ContractDataDurability::Persistent,
    })
}

/// The ledger key of the contract's persistent entry under `key`.
fn persistent_key(setup: &Setup, key: DataKey) -> LedgerKey {
    let key: Val = key.into_val(&setup.env);
    LedgerKey::ContractData(xdr::LedgerKeyContractData {
        contract: ScAddress::from(&setup.contract),
        key: xdr::ScVal::try_from_val(&setup.env, &key).unwrap(),
        durability: xdr::ContractDataDurability::Persistent,
    })
}

/// Asserts that the contract owns exactly the entries under `keys`, in any order, so an
/// entry kept in the wrong storage (the instance, or temporary storage) fails.
fn assert_owns_exactly(setup: &Setup, keys: &[LedgerKey]) {
    let mut owned: std::vec::Vec<LedgerKey> =
        our_entries(setup).into_iter().map(|(key, _)| key).collect();
    let mut expected = keys.to_vec();
    owned.sort();
    expected.sort();
    assert_eq!(owned, expected);
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

/// SC-ST-12. A14 (ADR-0011): setting a bank's collateral, with nothing else called,
/// extends the instance and the bank's credit entry to `BUMP_AMOUNT` ledgers from the
/// call. The credit entry is the bank's own persistent entry, so it is archived rather
/// than deleted if its TTL ever lapses, and not loaded with the instance on every call.
#[test]
fn setting_collateral_extends_the_instance_and_the_credit_to_thirty_days() {
    let setup = Setup::new(1, 0);
    setup.env.ledger().set_sequence_number(5_000);

    setup.client().set_collateral(setup.bank(0), &100);

    assert_owns_exactly(
        &setup,
        &[
            instance_key(&setup),
            persistent_key(&setup, DataKey::Credit(setup.bank(0).clone())),
        ],
    );
    assert_every_entry_lives_until(&setup, 5_000 + BUMP_AMOUNT);
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

/// The queue cap the cost tests hold the contract to: C-SC-204's ceiling of about 66
/// payments per transaction, less a margin. Provisional: ADR-0010 sizes the cap from
/// ADR-0007's target (OQ-29, OQ-30). If the implementation cannot fit it, lower it here
/// and record why.
///
/// Lowered from 64 in Flow 14, and to 62 in its third review. With account banks, as on
/// the network, a covered `submit` that makes a full ring of 63 feasible (SC-ST-09)
/// publishes 16,508 of Mainnet's 16,384 event bytes, and is refused. At 64, a cascade
/// also measured 401 and 402 of the test host's 400 footprint entries (SC-ST-05, SC-ST-07).
const QUEUE_CAP_UNDER_TEST: u32 = 62;

/// The Wasm that `make build` writes. `make test` builds it first.
const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/settlement.wasm"
);

/// The contract from its Wasm, with `banks` banks and the queue capped at
/// `QUEUE_CAP_UNDER_TEST`.
fn at_the_cap(banks: usize) -> Setup {
    let wasm =
        std::fs::read(WASM).unwrap_or_else(|err| panic!("{WASM}: {err}; run `make build` first"));
    Setup::from_wasm(
        &wasm,
        banks,
        Config {
            queue_cap: QUEUE_CAP_UNDER_TEST,
            ..default_config()
        },
    )
}

/// The footprint entries the test host counts for the last call: every entry read, and
/// every entry written once more.
fn test_host_footprint(setup: &Setup) -> u32 {
    let used = setup.env.cost_estimate().resources();
    used.disk_read_entries + used.memory_read_entries + used.write_entries
}

/// The last call kept within Stellar Mainnet's per-transaction limits. The test host
/// applies them to every invocation (soroban-sdk's `InvocationResourceLimits::mainnet`, a
/// snapshot of 2026-07-10), so a call over them fails; these checks name the limits that
/// matter. The test host counts a written entry twice towards the 400 footprint entries,
/// once read and once written; Mainnet counts it once. Mainnet also counts the call's
/// encoded return value, `returned`, towards the 16,384 event bytes, and the test host
/// doesn't.
fn assert_within_mainnet_limits(setup: &Setup, returned: &xdr::ScVal) {
    let used = setup.env.cost_estimate().resources();
    let returned_bytes = u32::try_from(returned.to_xdr(Limits::none()).unwrap().len()).unwrap();
    assert!(used.write_entries <= 200, "{used:?}");
    assert!(used.instructions <= 400_000_000, "{used:?}");
    assert!(used.mem_bytes <= 41_943_040, "{used:?}");
    assert!(used.write_bytes <= 132_096, "{used:?}");
    assert!(
        used.contract_events_size_bytes + returned_bytes <= 16_384,
        "{returned_bytes} returned: {used:?}"
    );
    assert!(test_host_footprint(setup) <= 400, "{used:?}");
}

/// How many `Offset` events this contract published in the last call.
fn offsets_published(setup: &Setup) -> usize {
    let topics = |event: &xdr::ContractEvent| match &event.body {
        xdr::ContractEventBody::V0(body) => body.topics.clone(),
    };
    let offset = topics(&setup.ev(Offset {
        ids: Vec::new(&setup.env),
    }));
    setup
        .our_events()
        .iter()
        .filter(|event| topics(event) == offset)
        .count()
}

/// What a cost test's call measured: its test-host footprint entries, which it may use at
/// most, and its event bytes, which it must publish exactly. Exactly, so that pricing the
/// events too low fails as well as pricing them too high: with contract banks instead of
/// Stellar accounts, every clearing test publishes fewer bytes and fails (Flow 15's
/// review).
struct Budget {
    footprint: u32,
    events: u32,
}

/// Checks that the last call, which returned `returned`, settled every queued payment
/// within Mainnet's limits and within its `budget`, publishing `offsets` `Offset` events,
/// and left the balances `expected`.
fn assert_cleared_the_queue(
    setup: &Setup,
    returned: &xdr::ScVal,
    offsets: usize,
    budget: &Budget,
    expected: &[i128],
) {
    assert_within_mainnet_limits(setup, returned);
    let used = setup.env.cost_estimate().resources();
    assert!(test_host_footprint(setup) <= budget.footprint, "{used:?}");
    assert_eq!(used.contract_events_size_bytes, budget.events, "{used:?}");
    assert_eq!(offsets_published(setup), offsets);
    assert_eq!(setup.client().queued_count(), 0);
    assert_eq!(setup.balances(), expected);
    setup.assert_conserved();
}

/// Funds bank 0 with `amount` and deposits it, then checks that the deposit cleared the
/// full queue as [`assert_cleared_the_queue`] does.
fn deposit_clears_the_queue(
    setup: &Setup,
    amount: i128,
    offsets: usize,
    budget: &Budget,
    expected: &[i128],
) {
    let client = setup.client();
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);
    setup.mint(setup.bank(0), amount);

    client.deposit(setup.bank(0), &amount);

    assert_cleared_the_queue(setup, &xdr::ScVal::Void, offsets, budget, expected);
}

/// Funds bank `outside` with `amount` and deposits it, which settles nothing, then has it
/// pay bank 0 `amount` urgent. The payment is covered, so `submit` accepts it with the
/// queue full, settles it, and runs the closure from bank 0. Checks that the submission
/// cleared the full queue as [`assert_cleared_the_queue`] does.
fn covered_submit_clears_the_queue(
    setup: &Setup,
    outside: usize,
    amount: i128,
    offsets: usize,
    budget: &Budget,
    expected: &[i128],
) {
    let client = setup.client();
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);
    setup.mint(setup.bank(outside), amount);
    client.deposit(setup.bank(outside), &amount);
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);

    let id = client.submit(setup.bank(outside), setup.bank(0), &amount, &URGENT);

    assert_cleared_the_queue(setup, &xdr::ScVal::U64(id), offsets, budget, expected);
}

// What a call that clears a full queue costs. The closure writes, for each payment it
// settles, the payment, and for each queue and each balance it changes, that entry. A
// queue holds at least one payment, so there are at most as many queues as payments. The
// settled payments connect every account to the bank whose call started the closure, so
// there is at most one more account than payments, and only a cascade with no cycle
// reaches that: an offset needs one. A payment the call settles itself counts among the
// payments, so a covered `submit` at the cap settles 63 payments across 64 accounts, one
// more of each than a deposit can. SC-ST-08 is that worst case for entries.
//
// Since Flow 15 the cap refuses only a payment still queued after the closure, so a
// payment that completes an offset over a full queue is accepted too: it settles 63
// payments across 63 accounts, within the same bound (SC-ST-10). A submission the cap
// refuses does the work of one that queues, the payment queued and an offset that settles
// nothing, before the refusal rolls it back. That offset reads every queued payment, its
// queue and both its accounts, so its worst case has a distinct sender and receiver for
// each payment (SC-ST-11). `revoke` and `expire` free a slot, and `reprioritise` settles at
// most the queued payments.
//
// Events cost too: each payment the call settles publishes a `Settled` event naming two
// banks, about 250 bytes with account banks, and an offset adds one `Offset` event with
// every id. SC-ST-10, a submission that completes an offset over the full queue, publishes
// the most.
//
// Three limits come close, and they count differently. Mainnet allows 16,384 bytes of
// events and return value, 200 written entries, and 400 footprint entries counted once
// each. The test host leaves the return value out of the events, 4 bytes for a deposit's
// `()` and 12 for a submission's id, so `assert_within_mainnet_limits` adds it. The test
// host also counts a written entry twice towards the 400, so in the tests the footprint
// comes closer than on Mainnet. The banks are Stellar accounts, as on the network: an account address is 4
// bytes longer in XDR than a contract address, so events would be understated with
// contract banks.
//
// Measured in Flow 14 at a cap of 62, as test-host footprint entries of 400, writes of
// 200 and event bytes of 16,384: SC-ST-04 387, 191 and 16,132; SC-ST-05 389, 192 and
// 15,284; SC-ST-06 388, 192 and 16,132; SC-ST-07 390, 193 and 15,284; SC-ST-08 392, 194
// and 15,408; SC-ST-09 389, 192 and 16,256, or 16,268 with its return value. None uses
// more than about 84M instructions. Events bind first: at 63, SC-ST-09 needs 16,508 bytes,
// and SC-ST-04 and SC-ST-06 16,384, which their return value takes over Mainnet's limit.
// So 62 is the most this layout and these events fit.
//
// Measured in Flow 15 at 62: SC-ST-10 392, 194 and 16,268, or 16,280 with its return
// value, 104 bytes short of the limit, less than one `Settled` event; its queue alternates
// priorities, so it writes both indexes and ties SC-ST-08 for the most entries. At 63 it
// needed 16,532. SC-ST-11, a refusal, 267 entries, 6 writes, no events and about 38M
// instructions.
//
// Each test also holds its call to what it measured, its budget, so that one needless
// entry, or a larger event, fails the test it adds to instead of waiting for the limit.
// The event bytes are held exactly, so that events priced too low fail too. Change a
// budget only for an entry or an event field a flow changes on purpose, and say why.
//
// Not priced: the tests mock authorization. On the network, a bank that signs rather than
// being the transaction's source account also costs a read of its account and a nonce
// written. That is a few entries, well within the writes, but no test measures it.

/// `n` banks in a ring, bank `i` paying the next `100 - i` normal, every balance 0, so
/// everything queues.
fn submit_ring(setup: &Setup, n: usize) {
    for i in 0..n {
        setup.client().submit(
            setup.bank(i),
            setup.bank((i + 1) % n),
            &(100 - i as i128),
            &NORMAL,
        );
    }
}

/// A binary tree of `n + 1` banks: bank `parent` pays its children, bank `2 * parent + 1`
/// urgent and bank `2 * parent + 2` normal, each what the child pays on plus 1. Every
/// balance is 0, so everything queues. Returns what bank 0 must receive to settle it all,
/// 1 more than it pays.
fn submit_tree(setup: &Setup, n: usize) -> i128 {
    // need[parent]: what bank `parent` receives, 1 more than it pays its children.
    let mut need = std::vec![1_i128; n + 1];
    for parent in (0..=n).rev() {
        for child in [2 * parent + 1, 2 * parent + 2] {
            if child <= n {
                need[parent] += need[child];
            }
        }
    }
    let client = setup.client();
    for parent in 0..=n {
        for (child, priority) in [(2 * parent + 1, URGENT), (2 * parent + 2, NORMAL)] {
            if child <= n {
                client.submit(
                    setup.bank(parent),
                    setup.bank(child),
                    &need[child],
                    &priority,
                );
            }
        }
    }
    need[0]
}

/// SC-ST-04. ADR-0010's cap, priced for the offset: with the queue full, a deposit makes
/// the whole of it feasible at once, and one transaction settles every queued payment by
/// offset (A3, S23) within Stellar Mainnet's per-transaction limits.
///
/// `n` banks in a ring (`submit_ring`). Bank 0 is `n - 1` short, and every other bank
/// receives 1 more than it pays. Bank 0's deposit of `n - 1` makes the ring feasible, and
/// the offset then touches every bank, every queue and every payment, and changes every
/// balance: bank 0 ends at 0 and every other bank at 1.
#[test]
fn an_offset_over_a_full_queue_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n);
    submit_ring(&setup, n);
    let mut expected = std::vec![1_i128; n];
    expected[0] = 0;
    deposit_clears_the_queue(
        &setup,
        n as i128 - 1,
        1,
        &Budget {
            footprint: 387,
            events: 16_132,
        },
        &expected,
    );
}

/// SC-ST-05. ADR-0010's cap holds for the whole eager closure, not only the offset: with
/// the queue full, a deposit that covers bank 0's head settles every queued payment gross,
/// as one cascade (A2, S9), in one transaction within Mainnet's limits.
///
/// `n + 1` banks in a path, bank `i` paying bank `i + 1` the amount `100 - i`, every
/// balance 0, so everything queues. Bank 0 deposits 100, its whole payment: each
/// settlement covers the receiver's head, so the path settles payment by payment, with no
/// offset, and every balance changes. It has one account more than payments. Added in
/// Flow 14: it fails if gross settlement reads a visited bank's queues that do not exist
/// (a ring of `n` measured 463 footprint entries), or if the cap leaves no room for that
/// extra account.
#[test]
fn a_gross_cascade_over_a_full_queue_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n + 1);
    for i in 0..n {
        setup.client().submit(
            setup.bank(i),
            setup.bank(i + 1),
            &(100 - i as i128),
            &NORMAL,
        );
    }
    let mut expected = std::vec![1_i128; n + 1];
    expected[0] = 0;
    expected[n] = 101 - n as i128;
    deposit_clears_the_queue(
        &setup,
        100,
        0,
        &Budget {
            footprint: 389,
            events: 15_284,
        },
        &expected,
    );
}

/// SC-ST-06. ADR-0010's cap for the offset with both priorities queued: banks in a ring,
/// each with an urgent payment to the next, and most with a normal one behind it (S7,
/// ADR-0009) to a bank outside the ring. One offset settles all of them (A3, S23) within
/// Mainnet's limits, and writes both indexes.
///
/// `ring = (n + 1) / 2` banks in the ring, and ring bank `i < n - ring` also pays bank
/// `ring + i` 1 normal, so there are `n` payments. The urgent amounts are set so that every ring
/// bank but bank 0 receives 1 more than it pays, and bank 0 deposits what it is short.
/// The offset changes every balance, bank 0's to 0 and every other bank's to 1. Added in
/// Flow 14.
#[test]
fn an_offset_over_a_full_queue_of_both_priorities_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let ring = n.div_ceil(2);
    let tails = n - ring;
    let setup = at_the_cap(n);
    let tail = |i: usize| i128::from(i < tails);
    // urgent[i] - urgent[i + 1] = tail(i + 1) + 1, so ring bank i + 1 nets 1.
    let mut urgent = std::vec![10_i128; ring];
    for i in (0..ring - 1).rev() {
        urgent[i] = urgent[i + 1] + tail(i + 1) + 1;
    }
    let client = setup.client();
    for (i, amount) in urgent.iter().enumerate() {
        client.submit(setup.bank(i), setup.bank((i + 1) % ring), amount, &URGENT);
        if i < tails {
            client.submit(setup.bank(i), setup.bank(ring + i), &1, &NORMAL);
        }
    }
    let short = urgent[0] + tail(0) - urgent[ring - 1];
    let mut expected = std::vec![1_i128; n];
    expected[0] = 0;
    deposit_clears_the_queue(
        &setup,
        short,
        1,
        &Budget {
            footprint: 388,
            events: 16_132,
        },
        &expected,
    );
}

/// SC-ST-07. ADR-0010's cap in the worst case for a deposit: with the queue full, a
/// deposit settles every queued payment as one gross cascade (A2, S9) down a binary tree
/// of `n + 1` banks with both priorities queued (S7, ADR-0009), in one transaction within
/// Mainnet's limits.
///
/// The tree is `submit_tree`'s. There are as many queues as payments, one more account
/// than payments, both indexes change, and every balance changes: bank 0 ends at 0 and
/// every other bank at 1. Added in Flow 14: at a cap of 64 it measured 402 test-host
/// footprint entries, and a path of 65 banks (SC-ST-05) 401.
#[test]
fn a_gross_cascade_down_a_tree_of_both_priorities_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n + 1);
    let need = submit_tree(&setup, n);
    let mut expected = std::vec![1_i128; n + 1];
    expected[0] = 0;
    deposit_clears_the_queue(
        &setup,
        need - 1,
        0,
        &Budget {
            footprint: 390,
            events: 15_284,
        },
        &expected,
    );
}

/// SC-ST-08. ADR-0010's cap in the worst case for the footprint and for writes: with the
/// queue full, a bank outside SC-ST-07's tree pays bank 0 a covered payment. The cap does
/// not refuse it (A1, SC-A01-09), it settles (A2), and the eager closure settles every
/// queued payment down the tree as one gross cascade (S9), in one transaction within
/// Mainnet's limits.
///
/// `n + 2` banks: the tree of `n + 1` (`submit_tree`) and bank `n + 1` outside it, which
/// pays bank 0 what the tree needs. That is `n + 1` payments across `n + 2` accounts, one
/// more of each than any deposit can settle. Every balance ends at 1 but the outside
/// bank's, at 0. Added in Flow 14's review: at 392 test-host footprint entries and 194
/// writes, it ties SC-ST-10 for the most entries of any call at the cap.
#[test]
fn a_covered_submission_cascading_down_a_full_tree_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n + 2);
    let need = submit_tree(&setup, n);
    let mut expected = std::vec![1_i128; n + 2];
    expected[n + 1] = 0;
    covered_submit_clears_the_queue(
        &setup,
        n + 1,
        need,
        0,
        &Budget {
            footprint: 392,
            events: 15_408,
        },
        &expected,
    );
}

/// SC-ST-09. ADR-0010's cap in the worst case for events: with the queue full, a bank
/// outside SC-ST-04's ring pays bank 0 the `n - 1` it is short, a covered payment that
/// settles at once (A1, A2). That makes the ring feasible, and one offset settles every
/// queued payment (A3, S23), in one transaction within Mainnet's limits.
///
/// `n + 1` banks: the ring of `n` (`submit_ring`) and bank `n` outside it. The call
/// publishes the submission, its settlement, the offset and a settlement per queued
/// payment. Bank 0 and the outside bank end at 0, and every other bank at 1. Added in
/// Flow 14's review: its 16,256 event bytes, 16,268 with its return value, left the least
/// room of any call at the cap until Flow 15's SC-ST-10, and with account banks a ring of
/// 63 measured 16,508, which set the cap at 62.
#[test]
fn a_covered_submission_that_makes_a_full_ring_feasible_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n + 1);
    submit_ring(&setup, n);
    let mut expected = std::vec![1_i128; n + 1];
    expected[0] = 0;
    expected[n] = 0;
    covered_submit_clears_the_queue(
        &setup,
        n,
        n as i128 - 1,
        1,
        &Budget {
            footprint: 389,
            events: 16_256,
        },
        &expected,
    );
}

/// SC-ST-10. ADR-0010's cap for a submission the closure settles: with the queue full, a
/// payment that completes an offset is accepted (SC-A01-23), so one `submit` settles one
/// payment more than the cap by offset (A3, S23), within Mainnet's limits.
///
/// `n + 1` banks in a ring, bank `i` paying the next `100 - i`. Bank 0 holds `n`, and the
/// other banks 0, so the `n` payments of banks 1 to `n` queue, the queue is full, and bank
/// 0's payment of 100 is not covered alone. It completes the ring: the offset touches
/// every bank, every queue and all `n + 1` payments, and changes every balance, bank 0's
/// to 0 and every other bank's to 1. The queued payments alternate priorities, so the
/// offset writes both indexes: that is the most it writes, and with SC-ST-08 the least
/// room in the footprint, as well as the least room in events. Added in Flow 15; red
/// first, since the closing payment was refused with `QueueFull`. Its ring had one
/// priority until Flow 15's review, which measured 391 entries.
#[test]
fn a_submission_that_completes_an_offset_over_a_full_queue_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = ring_but_bank_0(n);
    let client = setup.client();

    let id = client.submit(setup.bank(0), setup.bank(1), &100, &NORMAL);

    let mut expected = std::vec![1_i128; n + 1];
    expected[0] = 0;
    assert_cleared_the_queue(
        &setup,
        &xdr::ScVal::U64(id),
        1,
        &Budget {
            footprint: 392,
            events: 16_268,
        },
        &expected,
    );
    assert_eq!(client.payment(&id).unwrap().status, Status::Settled);
}

/// The contract from its Wasm with `n + 1` banks in a ring, bank `i` paying the next
/// `100 - i`, urgent from an odd bank and normal from an even one, and the queue full: bank
/// 0 holds `n` and has paid nothing yet, and the payments of banks 1 to `n` are queued,
/// since the other banks hold 0.
fn ring_but_bank_0(n: usize) -> Setup {
    let setup = at_the_cap(n + 1);
    let client = setup.client();
    setup.mint(setup.bank(0), n as i128);
    client.deposit(setup.bank(0), &(n as i128));
    for i in 1..=n {
        client.submit(
            setup.bank(i),
            setup.bank((i + 1) % (n + 1)),
            &(100 - i as i128),
            if i % 2 == 1 { &URGENT } else { &NORMAL },
        );
    }
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);
    setup
}

/// SC-ST-11. ADR-0010's cap for a refusal: since Flow 15 a submission at the cap is queued
/// and the eager closure runs before the cap is checked, so even a refused one pays for an
/// offset over the whole queue. It still fails with `QueueFull`, not a resource error,
/// within Mainnet's limits, and leaves the queue as it was.
///
/// The worst case for a refusal: the offset reads every queued payment, its sender's queue
/// and both its accounts, so `n + 1` payments from distinct senders to distinct receivers,
/// of both priorities, read the most. Bank `i`, for 1 to `n`, pays 1 to its own bank
/// `n + i`, urgent from an odd bank and normal from an even one, and every balance is 0, so
/// all `n` queue. Bank 0 then pays bank `2n + 1` 1: no prefix is feasible, the offset
/// settles nothing, and the payment is refused. Added in Flow 15; it passed before, when
/// the refusal came first, and fails if a refusal at the cap goes over Mainnet's limits
/// instead of returning `QueueFull`. Flow 15's review replaced this test's first fixture, a
/// ring that reads `n + 1` accounts, with this shape, which reads `2n + 2`.
#[test]
fn a_submission_refused_at_the_cap_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(2 * n + 2);
    let client = setup.client();
    for i in 1..=n {
        let priority = if i % 2 == 1 { URGENT } else { NORMAL };
        client.submit(setup.bank(i), setup.bank(n + i), &1, &priority);
    }
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);

    assert_eq!(
        client.try_submit(setup.bank(0), setup.bank(2 * n + 1), &1, &NORMAL),
        Err(Ok(Error::QueueFull))
    );

    assert_within_mainnet_limits(&setup, &xdr::ScVal::Void);
    assert!(
        test_host_footprint(&setup) <= 267,
        "over its budget of 267: {:?}",
        setup.env.cost_estimate().resources()
    );
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);
    assert_eq!(client.payment(&(n as u64)), None);
    setup.assert_conserved();
}
