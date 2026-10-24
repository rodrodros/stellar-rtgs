# Every target runs from the repository root. See README.md for the order to run them in.
.PHONY: check-env fmt lint build test cov devnet-up devnet-smoke devnet-down clean

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

devnet-up:
	devnet/up.sh

devnet-smoke: build
	devnet/smoke.sh

devnet-down:
	devnet/down.sh

clean:
	cargo clean
