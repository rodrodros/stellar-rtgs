#!/usr/bin/env bash
# Smoke test on the local network (devnet/up.sh first; `make devnet-smoke` builds the Wasm).
# An issuer issues a test cash asset and wraps it in its SAC; a bank opens a trustline and
# is paid; the settlement contract is deployed with that SAC as its token; the bank deposits
# and the contract's balance and token holdings are read back. Exits 1 on any mismatch.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

wasm="$repo/target/wasm32v1-none/release/settlement.wasm"
[ -f "$wasm" ] || die "no $wasm; run make build"
rpc_healthy >/dev/null || die "RPC at $IMPL_URL/rpc is not healthy; run devnet/up.sh"

for id in impl-issuer impl-bank; do
  stellar keys generate "$id" --overwrite >/dev/null 2>&1
  fund "$id"
done
issuer="$(stellar keys public-key impl-issuer)"
bank="$(stellar keys public-key impl-bank)"
asset="USD:$issuer"
log "issuer $issuer, bank $bank"

stellar tx new change-trust --source-account impl-bank --line "$asset" >/dev/null
stellar tx new payment --source-account impl-issuer --destination "$bank" --asset "$asset" --amount 1000 >/dev/null
sac="$(stellar contract asset deploy --asset "$asset" --source-account impl-issuer)"
log "cash token SAC $sac"

contract="$(stellar contract deploy --wasm "$wasm" --source-account impl-bank -- --token "$sac")"
log "settlement contract $contract"

stellar contract invoke --id "$contract" --source-account impl-bank -- deposit --bank "$bank" --amount 600 >/dev/null
balance="$(stellar contract invoke --id "$contract" --source-account impl-bank -- balance --bank "$bank" | tr -d '"')"
held="$(stellar contract invoke --id "$sac" --source-account impl-bank -- balance --id "$contract" | tr -d '"')"
log "balance(bank) = $balance; the contract holds $held"
[ "$balance" = 600 ] || die "expected balance 600, got $balance"
[ "$held" = 600 ] || die "expected the contract to hold 600, got $held"
log "smoke: ok"
