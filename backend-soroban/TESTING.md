# Testing guide

How to add each kind of test. Four layers exist today: unit and auth tests (§1), property and state-machine tests (§2), model-based tests (§3) and integration tests on the devnet (§4). Every other layer gets its folder and its Makefile and CI targets from whoever adds its first test, following the section below.

All commands come from the research handbook, which ran each of them on this machine: `../stellar-research/handbook/04-testing.md`. A worked example of every layer is in `../stellar-research/stellar/testing/lab/`. Copy from it, but keep this repo's names.

## Rules for every layer

- **Write the test first** (red), then the code (green). Then refactor. See `AGENTS.md`.
- **Name the model IDs.** A test's name or doc comment names what it checks: the actions (A*n*), invariants (S*n*), liveness properties (L*n*) or results (R*n*) of `../stellar-research/definition/rtgs-definition.md` §4, and the ADR it enforces. Example: `/// A1 then A2: a covered payment settles at once (S4, ADR-0008).`
- **Cover every input and output.** Each new contract entry point gets tests for:
  - its success case;
  - each error it can return;
  - each boundary: zero, negative, exactly the balance, one over, `i128` overflow;
  - its authorization, both granted and missing;
  - the events it publishes.
- **Keep the scenario catalogue up to date** (below). Every scenario row must point to the test that runs it.
- **Gate:** `make lint test build` must pass before you hand work back.

## Scenario catalogue

`tests/SCENARIOS.md` lists every behaviour the system must show. Add one row per scenario, in the form of these two rows:

| ID | Given | When | Then | Model IDs | ADR | Test |
|---|---|---|---|---|---|---|
| SC-001 | bank B holds 1,000 cash tokens | B deposits 600 | B holds 400 tokens, the contract 600; `balance(B)` = 600; one `Deposited` event | S1, S4, S6 | 0003, 0004 | `settlement::test::deposit_moves_tokens_into_the_contract_and_credits_the_bank` |
| SC-002 | the same, with no authorization from B | B's deposit is attempted | the call fails, and nothing moves | S6 | 0004 | `settlement::test::deposit_without_the_banks_authorization_fails` |

- **Coverage.** A row can be run by several layers; list every test. A gap shows up as a row with no test.
- **One family per action.** Number scenarios by the action they exercise, so it is easy to see which of A1–A20 still has none.

## 1. Unit and auth tests (the soroban-sdk test host)

**When:** for every contract behaviour. This is the default layer.

**Where:** `contracts/<name>/src/test.rs`. The template is the existing deposit tests. When the file grows, split it into `src/tests/{mod,unit,auth,support}.rs`, as the testing lab does.

**Run:** `make test`, or `cargo test -p settlement <name>`.

**How:**
- **Setup.** Build it with a helper like `Setup` in `src/test.rs`:
  - a test issuer's SAC as the cash token (`env.register_stellar_asset_contract_v2`);
  - the contract, registered with its constructor arguments;
  - banks from `Address::generate`, funded with `StellarAssetClient::mint`.
- **Authorizations.**
  - Assert the exact authorization tree with `env.auths()`. `mock_all_auths` alone passes a contract that forgot `require_auth` (C-HB-130).
  - For each entry point, add a test that calls `try_<fn>` with no auths mocked and expects it to fail.
- **Events.** `env.events().all()` holds only the last top-level invocation's events (C-HB-132). Read it right after the call. Compare against `MyEvent { .. }.to_xdr(&env, &contract)`.
- **Errors.** Use `#[contracterror]` enums. Assert `try_<fn>` returns `Err(Ok(Error::X))`, then assert that the state is unchanged.
- **Costs.** Register from Wasm when cost matters. A natively registered contract skips VM metering (C-HB-042): use `contractimport!` on `target/wasm32v1-none/release/settlement.wasm`, after `make build`.
- **Archival.** The test host restores archived entries by itself (C-HB-131, C-HB-145), so TTL behaviour needs the integration layer.
- **The batch limit.** It refuses batches above about 400 footprint entries (C-HB-137). Batch tests that pass here can still fail at the network's 200-write limit (C-SC-204).

## 2. Property and state-machine tests (proptest)

**When:**
- **Property tests:** for any rule over many inputs. Examples: conservation (S1), no negative balance beyond the limit (S2), FIFO order (S7), and that the greatest feasible prefix is unique (R4).
- **State-machine tests:** for sequences of contract calls.

**Where:**
- **Pure rules:** move them into `crates/rtgs-core` (covers, queue order, the prefix), and put their property tests there. Native and fast, and Kani can later prove the same code.
- **State-machine tests:** `contracts/settlement/src/tests/state_machine.rs`, using `proptest-state-machine`. Its reference model is a plain Rust struct that follows §4.

**Add:**
- **Dev-dependencies:** `proptest = "1.12.0"`, plus `proptest-state-machine = "0.9.0"` for state-machine tests. Those are the versions the testing lab used.
- **Run:** `make test`.

**Traps:**
- **Shrinking is degraded through `SorobanArbitrary`.** Generate plain Rust values, such as indexes into a bank list, and build the soroban values from them.
- **Keep the cases small.** Each one builds a whole `Env`.
- **No test snapshots.** soroban-sdk writes a JSON snapshot when an `Env` drops, one per proptest case, and that took nearly all of a property test's time (30 s against 0.65 s). `Setup::build` turns it off; any other `Env` a test builds needs `Env::new_with_config(EnvTestConfig { capture_snapshot_at_drop: false })`.
- **Pin a seed for CI.** `make test` runs every property with the fixed seed and case count in its `config()`. To explore further, set `PROPTEST_RNG_SEED` and `PROPTEST_CASES`, which override both: `PROPTEST_RNG_SEED=12345 PROPTEST_CASES=1000 cargo test -p settlement state_machine`. No scheduled job does this yet.

**Hand mutants.** To show that a property test catches a bug, run it against hand-written mutants, under the pinned seed and other seeds:

```sh
lib=contracts/settlement/src/lib.rs
cp $lib $SCRATCH/lib.rs   # edit the copy into the mutant, then:
diff -u --label a/$lib --label b/$lib $lib $SCRATCH/lib.rs > $SCRATCH/no_closure.patch
make mutate TEST=reprioritisation_moves_only_the_priority MUTANTS="$SCRATCH/*.patch"   # SEEDS=4 by default
```

- `scripts/mutate.sh` applies each patch to a copy in `target/mutate/`, builds it into its own target directory, and runs the test binary under every seed in parallel, with shrinking off. It prints one line per mutant: `no_closure  pinned: killed  seeds 1-4 killed: 4/4`, and exits 1 if any survives.
- The worktree is never edited, so other cargo commands and agents keep working while it runs.
- A sweep of six mutants takes about 15 s once `target/mutate/` is built; the first run builds the dependencies, about 75 s. `SEEDS=20` takes about 25 s.
- `make mutate-selftest` checks the script itself: a mutant the test catches is killed, a no-op mutant survives, and a stale patch is an error.

## 3. Model-based tests: Quint traces replayed against the contract

**When:** once the contract has payments and a queue, to check that it does what the model does, step by step.

**Where:**
- **`quint/`:** the spec and `quint/traces/*.itf.json`, which are committed.
- **The replay:** `contracts/settlement/src/tests/itf_replay.rs`.

**The spec.** `../stellar-research/definition/model/rtgs.qnt` is the full model, and its `init_proto` is κ-proto, the prototype's configuration. It still has a business day (A17, A18 and value dates), which ADR-0013 to ADR-0016 replace. Do one of these:
- Write a contract-level spec in `quint/settlement.qnt`, as the testing lab did. Its actions mirror the contract's entry points, and κ-proto's rules apply.
- Or take `rtgs.qnt` after the model's third round, which removes the day.

Either way, each step records `mbt::actionTaken` and `mbt::nondetPicks`, so the replay can make the same call.

**Commands** (handbook 04 §4):

```sh
cd quint
quint typecheck settlement.qnt
quint run settlement.qnt --max-samples 2000 --max-steps 30 --seed 0x6d875 --invariants <the S-properties>
mkdir -p quint-regen
quint run settlement.qnt --mbt --max-samples 500 --max-steps 30 --n-traces 50 \
  --out-itf quint-regen/trace.itf.json --seed 0x5e771e --invariants <the S-properties>
for f in traces/*.itf.json; do
  diff <(jq -S .states "$f") <(jq -S .states "quint-regen/$(basename "$f")") >/dev/null || echo "stale: $f"
done
cd .. && cargo test -p settlement itf_replay
```

**Traps:**
- **Output paths.** Quint inserts the trace number at the first dot of the whole `--out-itf` path, and it does not create directories. Keep the output directory free of dots: `mktemp -d` gives `tmp.XXXX` and breaks (C-HB-048).
- **Big integers.** ITF writes integers as `{"#bigint": "..."}` strings. Use the `itf` crate (`itf = "0.4.0"`, with `serde`) to decode them (C-ST-078).
- **Stale traces.** Regenerate with a fixed seed. CI fails when the committed traces are stale.
- **Each replayed step must match** the model's outcome, success value or error name, and the resulting state.

## 4. Integration tests on the local devnet

**When:**
- for anything the test host can't show: classic accounts and trustlines, fees, real authorization signatures, RPC, TTL and archival, and transaction limits;
- for every multi-party settlement: PvP and DvP in one transaction.

**Where:** `integration/<scenario>.sh`, each one runnable on its own against `make devnet-up` and `make build`. Behaviour the contract doesn't have yet goes in `integration/pending/<scenario>.sh`, written test-first against the model and the ADRs. When the contract code lands, the scenario moves up into `integration/`.

**Run:**
- `make integration` runs every scenario. It stops at the first failure, then reports each pending scenario as `PENDING (red)`, or as `NOW PASSES` when it should move up.
- `make integration-strict` also fails on pending scenarios.
- `integration/<scenario>.sh` runs one on its own.
- Use the same `IMPL_NAME` and `IMPL_PORT` as `devnet-up`.

**How:**
- **Setup.** Source `integration/lib.sh`. It sources `devnet/common.sh` for the network, `fund` and `rpc`, and adds:
  - the cash-token setup ADR-0003 requires: `issue_cash_token` sets AUTH_REQUIRED, AUTH_REVOCABLE and CLAWBACK_ENABLED before any trustline; `open_bank` authorizes the trustline and pays the bank; `authorize_holder` authorizes the contract, which can't hold USD until it is authorized;
  - `deploy_settlement`, `deposit` (prints the transaction hash), `invoke` and `view`;
  - `send_as`, for authorization checks: it signs with the sender's key only and submits, so the network does the refusing. `stellar contract invoke` refuses to send a call it can't sign ("Missing signing key"), which tests the CLI, not the contract;
  - the checks: `check`, `expect_fail`, `tx_ledger` (finality), `contract_events` (`getEvents`), `ledger_entry` with `balance_key` and `instance_key` (`getLedgerEntries`, value and TTL), and `seq_num`.
- **Identities.** Give each scenario its own `it-<scenario>-*` names, and create them with `new_ids`, which overwrites old keys so every run starts from fresh accounts.
- **Names.** The header comment names the model IDs and ADRs, as in the other layers.
- **Known hazards.** A scenario can pin behaviour that is wrong but can't be fixed yet, as `issuer-powers-hazard.sh` does. Say so in its header, and say what must change when the fix lands.
- **Red.** A scenario that tests existing code can't fail by itself. Seed a bug in the contract, check that the scenario fails for the expected reason, and revert. Record the output in the commit message.

**Traps:**
- **One source account per concurrent stream.** A second transaction from the same account in one ledger gets `TRY_AGAIN_LATER` (C-HB-160).
- **Failed transactions still pay their fee and use their sequence number** (C-HB-162, C-HB-163). Budget fees, and resync sequence numbers after a failure.
- **Fees are per operation.** A multi-operation transaction needs its inclusion fee scaled (C-HB-161).
- **Submission is asynchronous:** PENDING, then poll `getTransaction` (C-HB-160).
- **Friendbot.** Use `fund` from `devnet/common.sh`. RPC advertises friendbot on the container's port 8000, not ours (C-HB-073).
- **Make every script fail on purpose once,** and check that it exits non-zero. Smoke scripts that exit 0 after a failed step have happened before (C-HB-091).
- **Issuer flags.** Set AUTH_REQUIRED, AUTH_REVOCABLE and clawback on an issuer before any trustline opens: clawback can't be imposed on existing holders (C-HB-164).
- **Ledgers close every second** locally (C-ST-068), so TTLs run out sooner than on a real network.
- **Amounts are in stroops.** `stellar tx new payment --amount 1000` pays 1,000 of the SAC's i128 units, not 1,000 USD. The contract and the SAC count in the same units.
- **Run the scripts with bash.** `lib.sh` finds its path through `BASH_SOURCE`, so sourcing it from zsh fails.
- **Failures inside `$(...)`.** `lib.sh` sends `log` and `die` to stderr, so a helper that dies inside a command substitution still shows why. A substitution inside `<<<` or a pipe doesn't stop a `set -e` script, so assign its result on its own line first.
- **A simulation that fails has no auth entries.** Check `.result.error` before reading `authJson`.

## 5. Later layers

Add each of these when there is code worth it. Commands are in handbook 04.

| Layer | When | Where and how | Trap |
|---|---|---|---|
| Coverage | now, informational; gate at 95% once payments exist | `make cov`; add `--fail-under-lines 95` | Code run as Wasm shows 0%; exclude the Kani crate (C-ST-107) |
| Mutation | once the settlement logic exists and no test is red | `cargo mutants --no-shuffle -p settlement -j 4`; require 0 missed. Until then, hand mutants (§2) | 97% coverage still missed 3 mutants in the lab (C-ST-033). Its baseline must pass, so the red tests of later flows block it |
| Kani | for rules in `crates/rtgs-core` | a `kani/` crate with small bounds; `cargo kani` | Can't compile the test host (C-ST-059); keep proofs one step |
| Fuzzing | once there are entry points with arithmetic | `cargo +nightly fuzz` in `contracts/settlement/fuzz` | On macOS, use `--sanitizer=none` (C-HB-051) |
| Scout | before any review | `SCOUT_OFFLINE=1 cargo scout-audit ...` | Exits 0 with findings; fail on the `FAIL` file (C-HB-050) |
| Fork tests | once the contract is deployed somewhere worth copying | `fork/`, `Env::from_ledger_snapshot_file` | Snapshots hold contract data only (C-HB-053) |

When you add a layer:
- give it a `make` target;
- give it a step in `.github/workflows/ci.yml`, and check that with `action-validator`;
- add a line to the README's quick start.
