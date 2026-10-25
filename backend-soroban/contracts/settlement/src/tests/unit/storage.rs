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

/// Every ledger entry this contract owns (its instance and its own data), with what it
/// holds and the ledger it lives until.
fn our_entries_with_data(setup: &Setup) -> std::vec::Vec<(LedgerKey, xdr::LedgerEntryData, u32)> {
    let ours = ScAddress::from(&setup.contract);
    setup
        .env
        .to_ledger_snapshot()
        .ledger_entries
        .iter()
        .filter_map(|(key, (entry, live_until))| match key.as_ref() {
            LedgerKey::ContractData(data) if data.contract == ours => Some((
                (**key).clone(),
                entry.data.clone(),
                live_until.expect("contract data has a TTL"),
            )),
            _ => None,
        })
        .collect()
}

/// Every ledger entry this contract owns, with the ledger it lives until.
fn our_entries(setup: &Setup) -> std::vec::Vec<(LedgerKey, u32)> {
    our_entries_with_data(setup)
        .into_iter()
        .map(|(key, _, live_until)| (key, live_until))
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

/// SC-ST-15. A12 (ADR-0011): a repo opened once the instance's TTL is below the threshold,
/// with only the collateral set before, extends the instance, the bank's credit and
/// balance, the repo and its id counter to `BUMP_AMOUNT` ledgers from the call. Added in
/// Flow 17's review: it fails if `open_repo` leaves the instance to the other entry
/// points, which SC-ST-03 cannot see, since its `set_collateral` extends the instance in
/// the same ledger.
#[test]
fn a_repo_extends_the_instance_and_its_entries_to_thirty_days() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    setup.env.ledger().set_sequence_number(1_000);
    client.set_collateral(setup.bank(0), &100);
    let later = 1_000 + DAY_IN_LEDGERS + 1;
    setup.env.ledger().set_sequence_number(later);

    client.open_repo(setup.bank(0), &60);

    assert_every_entry_lives_until(&setup, later + BUMP_AMOUNT);
}

/// The ledger the contract's entry under `key` lives until.
fn live_until(setup: &Setup, key: &LedgerKey) -> u32 {
    our_entries(setup)
        .into_iter()
        .find_map(|(owned, live_until)| (owned == *key).then_some(live_until))
        .expect("the contract has this entry")
}

/// SC-ST-16. ADR-0014: converting an overdue repo extends what it writes, the instance,
/// the repo and the bank's credit, to `BUMP_AMOUNT` ledgers from the call. The repo was
/// opened so long before that every entry is below the threshold again, so an entry the
/// conversion forgot to extend would still live until the open's extension.
#[test]
fn converting_an_overdue_repo_extends_the_instance_the_repo_and_the_credit() {
    let setup = Setup::new(1, 0);
    let client = setup.client();
    setup.env.ledger().set_sequence_number(1_000);
    client.set_collateral(setup.bank(0), &100);
    let id = client.open_repo(setup.bank(0), &60);

    let later = 1_000 + (BUMP_AMOUNT - BUMP_THRESHOLD) + 1;
    setup.env.ledger().set_sequence_number(later);
    setup.at(default_config().repo_term_secs + 1);
    client.convert_overdue(&id);

    for key in [
        instance_key(&setup),
        persistent_key(&setup, DataKey::Repo(id)),
        persistent_key(&setup, DataKey::Credit(setup.bank(0).clone())),
    ] {
        assert_eq!(
            live_until(&setup, &key),
            later + BUMP_AMOUNT,
            "entry {key:?}"
        );
    }
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

/// Runs `call`, named `name`, on a ledger of its own, `BUMP_AMOUNT - BUMP_THRESHOLD + 1`
/// after `ledger`, when every entry is below the threshold again. Then checks that the
/// instance and every entry the call wrote live `BUMP_AMOUNT` ledgers from it. An entry
/// counts as written when it is new or holds something new, so one rewritten with the same
/// value is not checked. Returns what `call` returned.
///
/// The ledger moves on about a day and the close time stays put: the contract reads the
/// close time only for expiry and the repo term, and the scenario sets it itself where
/// those need it.
fn on_a_ledger_of_its_own<R>(
    setup: &Setup,
    ledger: &mut u32,
    name: &str,
    call: impl FnOnce() -> R,
) -> R {
    *ledger += BUMP_AMOUNT - BUMP_THRESHOLD + 1;
    setup.env.ledger().set_sequence_number(*ledger);
    let before = our_entries_with_data(setup);

    let returned = call();

    for (key, data, live_until) in our_entries_with_data(setup) {
        let instance = matches!(&key, LedgerKey::ContractData(entry)
            if entry.key == xdr::ScVal::LedgerKeyContractInstance);
        let written = !before
            .iter()
            .any(|(old_key, old_data, _)| *old_key == key && *old_data == data);
        if instance || written {
            assert_eq!(live_until, *ledger + BUMP_AMOUNT, "{name}: entry {key:?}");
        }
    }
    returned
}

/// SC-ST-03. ADR-0004, ADR-0014, ADR-0015: every entry point extends, by itself, the instance and
/// every entry it writes: payments, queues and their indexes, balances, credit, repos and
/// their counters. Each call runs on a ledger of its own, once every entry is below the
/// threshold again, so an entry the call forgot to extend still lives until an earlier
/// call's extension. In one shared ledger, any later write of the same entry hid it
/// (Flow 19's review, Flow 20). An entry rewritten with the value it already held is not
/// checked: a ledger snapshot cannot tell that write from a read.
///
/// The calls cover each entry point and the paths that write on its behalf: a submission
/// that settles at once or queues (A1, A2); revoke, reprioritise and expire (A6, A8, A5);
/// collateral, repos, a repayment, a conversion and a penalty repo repaid by the central
/// bank (A14, A12, A13, ADR-0014, A20); a deposit that covers a queued head and cascades
/// (A11, A2, S9), and one that makes an offset feasible (A3, S23). The cascade and the
/// offset each leave a queue shorter but not empty, and the offset leaves its index
/// shorter but not empty, so those rewrites are checked too. Their payments are
/// submitted after the clock moves, so none is past its expiry (ADR-0015).
#[test]
fn every_entry_point_extends_every_entry_it_writes() {
    let setup = Setup::new(3, 1_000);
    let client = setup.client();
    let (bank_0, bank_1, bank_2) = (setup.bank(0), setup.bank(1), setup.bank(2));
    let mut ledger = 5_000;
    setup.at(1_000);
    let ledger = &mut ledger;

    on_a_ledger_of_its_own(&setup, ledger, "deposit", || client.deposit(bank_0, &500));
    on_a_ledger_of_its_own(&setup, ledger, "withdraw", || client.withdraw(bank_0, &100));
    on_a_ledger_of_its_own(&setup, ledger, "submit, settled at once", || {
        client.submit(bank_0, bank_1, &50, &NORMAL)
    });
    let revoked = on_a_ledger_of_its_own(&setup, ledger, "submit, queued", || {
        client.submit(bank_1, bank_2, &900, &NORMAL)
    });
    let moved = on_a_ledger_of_its_own(&setup, ledger, "submit, behind a queued one", || {
        client.submit(bank_1, bank_2, &800, &NORMAL)
    });
    let expired = on_a_ledger_of_its_own(&setup, ledger, "submit, into the index", || {
        client.submit(bank_2, bank_0, &700, &NORMAL)
    });
    on_a_ledger_of_its_own(&setup, ledger, "revoke", || client.revoke(&revoked));
    on_a_ledger_of_its_own(&setup, ledger, "reprioritise", || {
        client.reprioritise(&moved, &URGENT)
    });
    on_a_ledger_of_its_own(&setup, ledger, "set_collateral", || {
        client.set_collateral(bank_2, &300)
    });
    let repo = on_a_ledger_of_its_own(&setup, ledger, "open_repo", || {
        client.open_repo(bank_2, &200)
    });
    on_a_ledger_of_its_own(&setup, ledger, "repay", || client.repay(bank_2, &repo, &50));
    let overdue = on_a_ledger_of_its_own(&setup, ledger, "open_repo, a second", || {
        client.open_repo(bank_2, &50)
    });
    setup.at(1_000
        + default_config()
            .expiry_secs
            .max(default_config().repo_term_secs)
        + 1);
    on_a_ledger_of_its_own(&setup, ledger, "expire", || client.expire(&expired));
    on_a_ledger_of_its_own(&setup, ledger, "convert_overdue", || {
        client.convert_overdue(&overdue)
    });
    on_a_ledger_of_its_own(&setup, ledger, "repay a penalty repo, by the CB", || {
        client.repay(&setup.cb, &overdue, &50)
    });

    // Balances: bank 0 350, bank 1 50, bank 2 150. `moved` is past its expiry by now, so
    // it is revoked out of the way (ADR-0015), and fresh payments queue: bank 1's urgent 800, and bank 2's 900 and
    // 5,000. Bank 1's deposit covers its head, and what bank 2 receives covers its 900
    // but not its 5,000, so bank 2's queue is rewritten shorter.
    client.revoke(&moved);
    client.submit(bank_1, bank_2, &800, &URGENT);
    let cascaded = client.submit(bank_2, bank_0, &900, &NORMAL);
    let left_by_the_cascade = client.submit(bank_2, bank_0, &5_000, &NORMAL);
    on_a_ledger_of_its_own(&setup, ledger, "deposit, cascading", || {
        client.deposit(bank_1, &750)
    });
    assert_eq!(client.payment(&cascaded).unwrap().status, Status::Settled);
    assert_eq!(setup.queue(2, NORMAL), [left_by_the_cascade]);

    // Balances: bank 0 1,250, bank 1 0, bank 2 50. Bank 1 owes bank 0 2,000, and bank 0
    // owes bank 1 3,500, then bank 2 10,000, submitted urgent and moved behind the 3,500,
    // into a queue that isn't empty. Bank 0's deposit of 250 makes the first two offset;
    // bank 0's 10,000 and bank 2's 5,000 stay queued. So the offset rewrites bank 0's
    // queue and the normal index shorter, and the queued count, which the deposit
    // doesn't write.
    let offset = client.submit(bank_1, bank_0, &2_000, &NORMAL);
    client.submit(bank_0, bank_1, &3_500, &NORMAL);
    let left_by_the_offset = client.submit(bank_0, bank_2, &10_000, &URGENT);
    on_a_ledger_of_its_own(&setup, ledger, "reprioritise, into a queue", || {
        client.reprioritise(&left_by_the_offset, &NORMAL)
    });
    assert_eq!(client.queued_count(), 4);
    on_a_ledger_of_its_own(&setup, ledger, "deposit, making an offset feasible", || {
        client.deposit(bank_0, &250)
    });
    assert_eq!(client.payment(&offset).unwrap().status, Status::Settled);
    assert_eq!(setup.queue(0, NORMAL), [left_by_the_offset]);
    assert_eq!(client.queued_count(), 2);
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
    assert_settled_all_but(setup, returned, offsets, budget, 0, expected);
}

/// [`assert_cleared_the_queue`], for a call that leaves `left` payments queued.
fn assert_settled_all_but(
    setup: &Setup,
    returned: &xdr::ScVal,
    offsets: usize,
    budget: &Budget,
    left: u32,
    expected: &[i128],
) {
    assert_within_budget(setup, returned, budget);
    assert_eq!(offsets_published(setup), offsets);
    assert_eq!(setup.client().queued_count(), left);
    assert_eq!(setup.balances(), expected);
    setup.assert_conserved();
}

/// The last call, which returned `returned`, kept within Mainnet's limits and within its
/// `budget`.
fn assert_within_budget(setup: &Setup, returned: &xdr::ScVal, budget: &Budget) {
    assert_within_mainnet_limits(setup, returned);
    let used = setup.env.cost_estimate().resources();
    assert!(test_host_footprint(setup) <= budget.footprint, "{used:?}");
    assert_eq!(used.contract_events_size_bytes, budget.events, "{used:?}");
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
// each payment (SC-ST-11). `revoke`, `expire` and `reprioritise` settle at most n - 1
// (SC-ST-17 to SC-ST-22), and the entry points that run no closure read no queue
// (SC-ST-23).
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
// `open_repo` (Flow 17) runs the closure too and, like a deposit, settles at most the n
// queued payments. It writes the repo, the repo id counter and the bank's credit where a
// deposit writes the bank's token balance, and its events are `RepoOpened` and the SAC's
// `mint` where a deposit's are `Deposited` and the `transfer`. Measured in Flow 17 at 62:
// SC-ST-13, down SC-ST-07's tree, 394, 195 and 15,260, 4 entries and 2 writes more than
// the deposit of SC-ST-07, and the most entries of any call at the cap; SC-ST-14, over
// SC-ST-04's ring, 391, 193 and 16,108, or 16,120 with its return value, below SC-ST-10.
// So the cap stays at 62.
//
// `revoke`, `expire` and `reprioritise` (Flow 22) settle at most n - 1, behind a blocker
// (SC-ST-17 to SC-ST-22, below). Measured at 62, down SC-ST-07's tree and around
// SC-ST-04's ring: `revoke` 383, 190 and 14,732, and 381, 189 and 15,568; `expire`, which
// needs no authorization and so writes no nonce, 380, 189 and 14,732, and 378, 188 and
// 15,568; `reprioritise` 383, 189 and 14,784, and 382, 189 and 15,620. The entry points
// that run no closure (SC-ST-23), at a full queue: `withdraw` 12, 4 and 404,
// `set_collateral` 7, 2 and 168, `convert_overdue` 6, 2 and 124, and `repay` 14, 5 and
// 364. All are below `open_repo` and `submit`, so the cap stays at 62.
//
// Each test also holds its call to what it measured, its budget, so that one needless
// entry, or a larger event, fails the test it adds to instead of waiting for the limit.
// The event bytes are held exactly, so that events priced too low fail too. Change a
// budget only for an entry or an event field a flow changes on purpose, and say why.
//
// The tests mock authorization, but the measurements include each signer's nonce: the
// test host's transaction source is the all-zero account, never a bank or the central
// bank, so recording mode writes a nonce for every call, as the network does for a signer
// that is not the source. The network also reads each signer's account entry to verify
// it, which recording mode skips; counted once, as Mainnet counts it, that leaves the
// footprint far from its 400.

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
    submit_tree_from(setup, 0, n)
}

/// [`submit_tree`], with the tree's banks numbered from `root`, so bank `root` heads it.
fn submit_tree_from(setup: &Setup, root: usize, n: usize) -> i128 {
    // need[parent]: what bank `root + parent` receives, 1 more than it pays its children.
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
                    setup.bank(root + parent),
                    setup.bank(root + child),
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
/// writes, it ties SC-ST-10 for the most entries of any `deposit` or `submit` at the cap;
/// since Flow 17, a repo's (SC-ST-13) uses more.
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

/// Gives bank 0 the collateral for a repo of `amount` and has the central bank open it,
/// then checks that the repo cleared the full queue as [`assert_cleared_the_queue`] does.
fn repo_clears_the_queue(
    setup: &Setup,
    amount: i128,
    offsets: usize,
    budget: &Budget,
    expected: &[i128],
) {
    let client = setup.client();
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);
    client.set_collateral(setup.bank(0), &amount);

    let id = client.open_repo(setup.bank(0), &amount);

    assert_cleared_the_queue(setup, &xdr::ScVal::U64(id), offsets, budget, expected);
}

/// SC-ST-13. ADR-0010's cap for a repo: `open_repo` runs the eager closure (ADR-0011), so
/// with the queue full, the money a repo mints settles every queued payment as one gross
/// cascade (A12, A2, S9) down SC-ST-07's tree, in one transaction within Mainnet's limits.
/// A repo writes more of its own than a deposit, its repo, its id counter and the bank's
/// credit, so this is `open_repo`'s worst case for the footprint. Added in Flow 17.
#[test]
fn a_repo_that_cascades_down_a_full_tree_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n + 1);
    let need = submit_tree(&setup, n);
    let mut expected = std::vec![1_i128; n + 1];
    expected[0] = 0;
    repo_clears_the_queue(
        &setup,
        need - 1,
        0,
        &Budget {
            footprint: 394,
            events: 15_260,
        },
        &expected,
    );
}

/// SC-ST-14. ADR-0010's cap for a repo that makes an offset feasible: SC-ST-04's ring, and
/// bank 0's repo of the `n - 1` it is short settles the whole ring by offset (A12, A3,
/// S23) in one transaction within Mainnet's limits. Its events, the `Offset`, n `Settled`,
/// the `RepoOpened` and the SAC's `mint`, and its returned id are `open_repo`'s worst case
/// for the event bytes. Added in Flow 17.
#[test]
fn a_repo_that_completes_an_offset_over_a_full_queue_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n);
    submit_ring(&setup, n);
    let mut expected = std::vec![1_i128; n];
    expected[0] = 0;
    repo_clears_the_queue(
        &setup,
        n as i128 - 1,
        1,
        &Budget {
            footprint: 391,
            events: 16_108,
        },
        &expected,
    );
}

// The calls that take a payment out of the queue or move it, `revoke`, `expire` and
// `reprioritise`, run the eager closure from the payment's sender (S9, ADR-0010), so they
// are priced in the same two shapes: SC-ST-07's tree for the footprint, headed by bank 1
// and paid for by bank 0's normal payment to it, and SC-ST-04's ring for the event bytes.
// In each, bank 0's urgent `BLOCKER`, which bank 0 never
// covers, holds up every payment of bank 0's behind it (S7, ADR-0009), and so the whole
// shape: the queue is full and at rest, with bank 0 already holding what the shape needs.
// The call then gets the blocker out of the way, and the closure settles the other `n - 1`
// payments.
//
// That is the most these calls can settle. `revoke` and `expire` take the blocker out.
// `reprioritise` could settle all `n` only by settling the whole queue, and F1 decides
// that set by its members alone, whatever their order, so it was already feasible before
// the move and the closure had settled it (R4, S23). So the blocker stays queued, and
// the offset reads its receiver's balance: the blocker pays a bank outside the shape,
// which costs 1 test-host entry more than one in it. Each direction of the move was
// measured in both shapes, and each test takes the costlier (Flow 22's review). Down the
// tree, bank 0 moves its older normal payment to urgent, ahead of the younger blocker:
// 1 entry more than moving the blocker to normal. Around the ring, bank 0 moves the
// blocker to normal, behind its ring payment: 2 more than the other way.

/// More than bank 0 ever holds in these shapes.
const BLOCKER: i128 = 1_000_000;

/// Whether bank 0's blocker is older or younger than the shape it blocks.
#[derive(Clone, Copy)]
enum Blocker {
    /// Submitted first, and the shape a full expiry later: only the blocker can expire
    /// (ADR-0015).
    Older,
    /// Submitted after the shape, so that a move by age puts bank 0's normal payment ahead
    /// of it, moved to urgent (SC-ST-21), or it behind bank 0's normal payment, moved to
    /// normal (SC-ST-22; A8 with `toEnd = false`).
    Younger,
}

/// Submits the blocker, to the last bank, which is outside the shape, and `shape`, in the
/// order `blocker` says. Returns the blocker's id and what `shape` returned.
fn block<T>(setup: &Setup, blocker: Blocker, shape: impl FnOnce() -> T) -> (u64, T) {
    let outside = setup.bank(setup.banks.len() - 1);
    let submit_blocker = || {
        setup
            .client()
            .submit(setup.bank(0), outside, &BLOCKER, &URGENT)
    };
    match blocker {
        Blocker::Older => {
            let id = submit_blocker();
            setup.at(default_config().expiry_secs);
            (id, shape())
        }
        Blocker::Younger => {
            let submitted = shape();
            (submit_blocker(), submitted)
        }
    }
}

/// Funds bank 0 with `amount`, which settles nothing while the blocker holds the shape
/// up, and checks that the queue is full.
fn fund_bank_0(setup: &Setup, amount: i128) {
    let client = setup.client();
    setup.mint(setup.bank(0), amount);
    client.deposit(setup.bank(0), &amount);
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);
}

/// `n + 1` banks: bank 0 pays bank 1 normal what bank 1 needs to settle SC-ST-07's tree of
/// `n - 2` payments, headed by bank 1, and bank 0's blocker to bank `n` holds it up. So
/// the blocker is alone in its queue, and settling the shape changes `n` queues, 1 more
/// than SC-ST-07's tree of `n - 1` behind a blocker that shares bank 0's urgent queue
/// (Flow 22's second review). Bank 0 holds what bank 1 needs. Returns the blocker's id and
/// that of bank 0's normal payment.
fn blocked_branch(setup: &Setup, n: usize, blocker: Blocker) -> (u64, u64) {
    let (id, (normal, need)) = block(setup, blocker, || {
        let need = submit_tree_from(setup, 1, n - 2);
        let normal = setup
            .client()
            .submit(setup.bank(0), setup.bank(1), &need, &NORMAL);
        (normal, need)
    });
    fund_bank_0(setup, need);
    (id, normal)
}

/// `n` banks: SC-ST-04's ring of `n - 1` payments, behind bank 0's blocker to bank `n - 1`,
/// with bank 0 holding the `n - 2` it is short. Returns the blocker's id.
fn blocked_ring(setup: &Setup, n: usize, blocker: Blocker) -> u64 {
    let (id, ()) = block(setup, blocker, || submit_ring(setup, n - 1));
    fund_bank_0(setup, n as i128 - 2);
    id
}

/// The balances once a blocked shape of `banks` banks has settled: bank 0's 0, every other
/// bank's in the shape 1, and the blocker's receiver's, after them, 0.
fn settled_behind_the_blocker(banks: usize) -> std::vec::Vec<i128> {
    let mut expected = std::vec![1_i128; banks + 1];
    expected[0] = 0;
    expected[banks] = 0;
    expected
}

/// SC-ST-17. A6 (ADR-0016) at ADR-0010's cap, for the footprint: with the queue full,
/// revoking bank 0's older blocker releases its normal payment to bank 1 and SC-ST-07's
/// tree under bank 1, and the eager closure settles all `n - 1` of them as one gross
/// cascade (A2, S7, S9), in one transaction within Mainnet's limits.
#[test]
fn a_revocation_that_releases_a_full_tree_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n + 1);
    let (blocker, _) = blocked_branch(&setup, n, Blocker::Older);

    setup.client().revoke(&blocker);

    let budget = Budget {
        footprint: 383,
        events: 14_732,
    };
    let expected = settled_behind_the_blocker(n);
    assert_cleared_the_queue(&setup, &xdr::ScVal::Void, 0, &budget, &expected);
}

/// SC-ST-18. A6 (ADR-0016) at ADR-0010's cap, for the event bytes: with the queue full,
/// revoking bank 0's blocker makes SC-ST-04's ring feasible, and one offset settles all
/// `n - 1` of its payments (A3, S23), in one transaction within Mainnet's limits.
#[test]
fn a_revocation_that_makes_a_full_ring_feasible_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n);
    let blocker = blocked_ring(&setup, n, Blocker::Older);

    setup.client().revoke(&blocker);

    let budget = Budget {
        footprint: 381,
        events: 15_568,
    };
    let expected = settled_behind_the_blocker(n - 1);
    assert_cleared_the_queue(&setup, &xdr::ScVal::Void, 1, &budget, &expected);
}

/// SC-ST-19. A5 (ADR-0015) at ADR-0010's cap, for the footprint: SC-ST-17's shape, with the
/// blocker expired instead, by anyone and with no authorization (S6). The closure settles
/// all `n - 1` payments behind it as one gross cascade (A2, S7, S9), in one transaction
/// within Mainnet's limits. None of them is past its expiry.
#[test]
fn an_expiry_that_releases_a_full_tree_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n + 1);
    let (blocker, _) = blocked_branch(&setup, n, Blocker::Older);
    setup.at(default_config().expiry_secs + 1);

    setup.client().expire(&blocker);

    let budget = Budget {
        footprint: 380,
        events: 14_732,
    };
    let expected = settled_behind_the_blocker(n);
    assert_cleared_the_queue(&setup, &xdr::ScVal::Void, 0, &budget, &expected);
}

/// SC-ST-20. A5 (ADR-0015) at ADR-0010's cap, for the event bytes: SC-ST-18's ring, with
/// the blocker expired instead. One offset settles all `n - 1` payments of the ring (A3,
/// S23), in one transaction within Mainnet's limits.
#[test]
fn an_expiry_that_makes_a_full_ring_feasible_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n);
    let blocker = blocked_ring(&setup, n, Blocker::Older);
    setup.at(default_config().expiry_secs + 1);

    setup.client().expire(&blocker);

    let budget = Budget {
        footprint: 378,
        events: 15_568,
    };
    let expected = settled_behind_the_blocker(n - 1);
    assert_cleared_the_queue(&setup, &xdr::ScVal::Void, 1, &budget, &expected);
}

/// SC-ST-21. A8 (ADR-0009) at ADR-0010's cap, for the footprint: with the queue full, bank
/// 0 moves its normal payment to bank 1 to urgent, where it sorts ahead of its younger
/// blocker (A8 with `toEnd = false`). It settles, and the closure settles SC-ST-07's tree
/// under bank 1 as one gross cascade (A2, S7, S9): `n - 1` payments in one transaction
/// within Mainnet's limits. The blocker stays queued.
#[test]
fn a_reprioritisation_that_releases_a_full_tree_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n + 1);
    let (blocker, moved) = blocked_branch(&setup, n, Blocker::Younger);

    setup.client().reprioritise(&moved, &URGENT);

    let budget = Budget {
        footprint: 383,
        events: 14_784,
    };
    let expected = settled_behind_the_blocker(n);
    assert_settled_all_but(&setup, &xdr::ScVal::Void, 0, &budget, 1, &expected);
    assert_eq!(setup.queue(0, URGENT), [blocker]);
}

/// SC-ST-22. A8 (ADR-0009) at ADR-0010's cap, for the event bytes: SC-ST-18's ring behind
/// bank 0's younger blocker, which bank 0 moves to normal, where it sorts behind its ring
/// payment (A8 with `toEnd = false`). One offset settles all `n - 1` payments of the ring
/// (A3, S23), in one transaction within Mainnet's limits, and the blocker stays queued.
#[test]
fn a_reprioritisation_that_makes_a_full_ring_feasible_fits_in_one_transaction() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(n);
    let blocker = blocked_ring(&setup, n, Blocker::Younger);

    setup.client().reprioritise(&blocker, &NORMAL);

    let budget = Budget {
        footprint: 382,
        events: 15_620,
    };
    let expected = settled_behind_the_blocker(n - 1);
    assert_settled_all_but(&setup, &xdr::ScVal::Void, 1, &budget, 1, &expected);
    assert_eq!(setup.queue(0, NORMAL), [blocker]);
}

/// SC-ST-23. The entry points that run no eager closure, at ADR-0010's cap: with the queue
/// full, `withdraw` (A11), `set_collateral` (A14, ADR-0011), `convert_overdue` (ADR-0014)
/// and `repay` of that penalty repo by the central bank (A13, A20), each on a ledger of its
/// own so that it extends every entry it writes, keep within Mainnet's limits and within a
/// small budget: none reads the queue, so its cost doesn't grow with it.
///
/// The queue is SC-ST-11's: bank `i`, for 1 to `n`, pays 1 to its own bank `n + i`,
/// urgent and normal alternately, so it reads the most. Bank 0 holds 1,000 and a repo of
/// 500.
#[test]
fn the_entry_points_without_the_closure_fit_in_one_transaction_at_the_cap() {
    let n = QUEUE_CAP_UNDER_TEST as usize;
    let setup = at_the_cap(2 * n + 1);
    let client = setup.client();
    for i in 1..=n {
        let priority = if i % 2 == 1 { URGENT } else { NORMAL };
        client.submit(setup.bank(i), setup.bank(n + i), &1, &priority);
    }
    setup.mint(setup.bank(0), 1_000);
    client.deposit(setup.bank(0), &1_000);
    client.set_collateral(setup.bank(0), &1_000);
    let repo = client.open_repo(setup.bank(0), &500);
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);
    let mut ledger = setup.env.ledger().sequence();
    let next_ledger = |ledger: &mut u32| {
        *ledger += BUMP_AMOUNT - BUMP_THRESHOLD + 1;
        setup.env.ledger().set_sequence_number(*ledger);
    };

    next_ledger(&mut ledger);
    client.withdraw(setup.bank(0), &100);
    let withdrawn = Budget {
        footprint: 12,
        events: 404,
    };
    assert_within_budget(&setup, &xdr::ScVal::Void, &withdrawn);

    next_ledger(&mut ledger);
    client.set_collateral(setup.bank(0), &2_000);
    let collateral_set = Budget {
        footprint: 7,
        events: 168,
    };
    assert_within_budget(&setup, &xdr::ScVal::Void, &collateral_set);

    next_ledger(&mut ledger);
    setup.at(default_config().repo_term_secs + 1);
    client.convert_overdue(&repo);
    let converted = Budget {
        footprint: 6,
        events: 124,
    };
    assert_within_budget(&setup, &xdr::ScVal::Void, &converted);

    next_ledger(&mut ledger);
    client.repay(&setup.cb, &repo, &500);
    let repaid = Budget {
        footprint: 14,
        events: 364,
    };
    assert_within_budget(&setup, &xdr::ScVal::Void, &repaid);

    assert_eq!(client.repo(&repo).unwrap().status, RepoStatus::Repaid);
    assert_eq!(client.queued_count(), QUEUE_CAP_UNDER_TEST);
    setup.assert_conserved();
}
