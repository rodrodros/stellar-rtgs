#!/usr/bin/env bash
# Fails unless every tool matches the pins of stellar-research/handbook/01-toolchain.md.
# Required: rustc, the wasm32v1-none target, stellar-cli, Docker and the quickstart image's
# tag. quint and the cargo test plugins are checked when present and reported when missing,
# because only the later test layers need them (TESTING.md).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fail=1; }
note() { printf 'note  %s\n' "$*"; }

# expect <name> <wanted> <actual>
expect() { [ "$3" = "$2" ] && ok "$1 $3" || bad "$1: want $2, got ${3:-nothing}"; }

expect rustc 1.99.1 "$(rustc --version 2>/dev/null | awk '{print $2}')"
rustup target list --installed 2>/dev/null | grep -qx wasm32v1-none && ok "target wasm32v1-none" || bad "target wasm32v1-none is not installed"
expect stellar-cli 28.1.0 "$(stellar --version 2>/dev/null | awk 'NR==1{print $2}')"
expect soroban-sdk '"=29.0.1"' "$(sed -n 's/^soroban-sdk = //p' Cargo.toml)"
docker info >/dev/null 2>&1 && ok "docker daemon $(docker version --format '{{.Server.Version}}')" || bad "docker daemon is not reachable"
expect "quickstart image" stellar/quickstart:v678-b1525.1-latest "$(sed -n 's/.*IMPL_IMAGE:-\([^}]*\)}.*/\1/p' devnet/common.sh)"

if command -v quint >/dev/null; then expect quint 0.33.0 "$(quint --version 2>/dev/null)"; else note "quint missing (needed for Quint traces)"; fi
for plugin in llvm-cov mutants kani fuzz scout-audit; do
  command -v "cargo-$plugin" >/dev/null && ok "cargo-$plugin present" || note "cargo-$plugin missing (TESTING.md says which layer needs it)"
done
exit $fail
