# Every target runs from the repository root. See README.md for the order to run them in.
.PHONY: check-env fmt lint build test cov quint quint-traces devnet-up devnet-smoke devnet-down clean

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
# are stale. `cargo test -p settlement itf_replay` replays them against the contract.
QUINT_INVARIANTS = S1_conservation S2_noNegative S3_finalStaysFinal S7_fifo S9_atRest \
	S11_validity S23_eagerOffsetting queueBounded
QUINT_WITNESSES = W_offset W_queueFull W_expired W_revoked W_urgentOvertook W_deepQueue W_cascade
# Quint puts the trace number at the first dot of the whole path, so the directory must have
# none (C-HB-048).
QUINT_TRACES = quint run settlement.qnt --mbt --max-samples 500 --max-steps 30 --n-traces 50 \
	--seed 0x5e771e --invariants allInvariants --out-itf

quint: SHELL := bash
quint:
	cd quint && quint typecheck settlement.qnt && quint test settlement_test.qnt
	cd quint && quint run settlement.qnt --max-samples 2000 --max-steps 30 --seed 0x6d875 \
		--invariants $(QUINT_INVARIANTS) --witnesses $(QUINT_WITNESSES)
	cd quint && rm -rf quint-regen && mkdir quint-regen && $(QUINT_TRACES) quint-regen/trace.itf.json
	@cd quint && stale=0; for f in traces/*.itf.json; do \
		diff <(jq -S .states "$$f") <(jq -S .states "quint-regen/$$(basename "$$f")") >/dev/null \
			|| { echo "stale: $$f (run make quint-traces)"; stale=1; }; \
	done; exit $$stale

# Rewrites quint/traces/ from the model, after a change to quint/settlement.qnt.
quint-traces:
	cd quint && rm -f traces/*.itf.json && $(QUINT_TRACES) traces/trace.itf.json

devnet-up:
	devnet/up.sh

devnet-smoke: build
	devnet/smoke.sh

devnet-down:
	devnet/down.sh

clean:
	cargo clean
