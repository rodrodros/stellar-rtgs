# Every target runs from the repository root. See README.md for the order to run them in.
.PHONY: check-env fmt lint build test cov quint quint-traces devnet-up devnet-smoke devnet-down integration integration-strict clean

check-env:
	scripts/check-env.sh

fmt:
	cargo fmt --all

lint:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --locked -- -D warnings

# Builds every contract to Wasm. Plain `cargo build --target wasm32v1-none` is refused (C-HB-043).
build:
	stellar contract build
	@ls -l target/wasm32v1-none/release/*.wasm

# Builds first: the cost tests register the contract from its Wasm (TESTING.md, "Costs").
test: build
	cargo test --workspace --locked

# Informational for now; TESTING.md says when to turn on --fail-under-lines 95.
cov:
	cargo llvm-cov --workspace --locked --summary-only

# Model-based tests (TESTING.md §3): check the Quint model, then fail if the committed traces
# are stale or any witness is unreached. `cargo test -p settlement itf_replay` replays the
# traces against the contract.
QUINT_INVARIANTS = S1_conservation S2_noNegative S3_finalStaysFinal S5_irrevocability S7_fifo S9_atRest \
	S11_validity S23_eagerOffsetting queueBounded
QUINT_WITNESSES = W_offset W_queueFull W_expired W_revoked W_urgentOvertook W_deepQueue W_cascade
# Quint puts the trace number at the first dot of the whole path, so the directory must have
# none (C-HB-048).
QUINT_TRACES = quint run settlement.qnt --mbt --max-samples 500 --max-steps 30 --n-traces 50 \
	--seed 0x5e771e --invariants allInvariants --out-itf

quint:
	cd quint && quint typecheck settlement.qnt && quint test settlement_test.qnt
	mkdir -p quint/quint-regen
	cd quint && quint run settlement.qnt --max-samples 2000 --max-steps 30 --seed 0x6d875 \
		--invariants $(QUINT_INVARIANTS) --witnesses $(QUINT_WITNESSES) >quint-regen/run.txt; \
		status=$$?; cat quint-regen/run.txt; exit $$status
	@# `quint run` exits 0 even when a witness is never reached, so check its report.
	@! grep 'witnessed in 0 trace' quint/quint-regen/run.txt
	cd quint && rm -f quint-regen/*.itf.json && $(QUINT_TRACES) quint-regen/trace.itf.json
	scripts/check-traces-selftest.sh
	scripts/check-traces.sh quint/traces quint/quint-regen

# Rewrites quint/traces/ from the model, after a change to quint/settlement.qnt.
quint-traces:
	cd quint && rm -f traces/*.itf.json && $(QUINT_TRACES) traces/trace.itf.json

devnet-up:
	devnet/up.sh

devnet-smoke: build
	devnet/smoke.sh

# Every scenario in integration/ against the network from devnet-up. Pending scenarios
# (integration/pending/) are reported; integration-strict also fails on them.
integration: build
	integration/run.sh

integration-strict: build
	integration/run.sh --strict

devnet-down:
	devnet/down.sh

clean:
	cargo clean
