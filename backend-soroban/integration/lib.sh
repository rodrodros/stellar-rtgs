# Shared helpers for the integration scenarios. Source this file; don't run it.
# Builds on devnet/common.sh (network, identities, fund, rpc) and follows the testing lab's
# integration/smoke.sh. Every scenario runs against `make devnet-up` and `make build`.
#
# The cash token is set up as ADR-0003 requires: the issuer sets AUTH_REQUIRED,
# AUTH_REVOCABLE and CLAWBACK_ENABLED before any trustline opens (C-HB-164), and authorizes
# each bank's trustline and the settlement contract as holders.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/devnet/common.sh"

WASM="$repo/target/wasm32v1-none/release/settlement.wasm"
# What deposit's extend_ttl sets: 30 days of 5-second ledgers (contracts/settlement/src/lib.rs).
BUMP_AMOUNT=518400

[ -f "$WASM" ] || die "no $WASM; run make build"
rpc_healthy >/dev/null 2>&1 || die "RPC at $IMPL_URL/rpc is not healthy; run make devnet-up (IMPL_NAME=$IMPL_NAME IMPL_PORT=$IMPL_PORT)"

# check <what> <actual> <expected>
check() {
  if [ "$2" = "$3" ]; then log "ok    $1 = $3"; else die "$1: got '$2', want '$3'"; fi
}

# addr <identity>: its G... address.
addr() { stellar keys public-key "$1"; }

# new_ids <identity...>: fresh keys, funded by friendbot. A rerun overwrites them, so each run
# starts from new accounts. Give every scenario its own names: one source account per
# concurrent stream (C-HB-160).
new_ids() {
  local id
  for id in "$@"; do
    stellar keys generate "$id" --overwrite >/dev/null 2>&1
    fund "$id"
  done
}

# invoke <source> <contract> <fn> [args...]: signs and sends; prints the return value.
invoke() {
  local source="$1" id="$2"
  shift 2
  stellar contract invoke -q --source-account "$source" --id "$id" -- "$@"
}

# view <source> <contract> <fn> [args...]: simulation only; prints the value without quotes.
view() {
  local source="$1" id="$2"
  shift 2
  stellar contract invoke -q --send=no --source-account "$source" --id "$id" -- "$@" | tr -d '"'
}

# expect_fail <what> <pattern> <command...>: the command must exit non-zero, and its output
# must contain the pattern (grep -E).
expect_fail() {
  local what="$1" pattern="$2" out
  shift 2
  if out="$("$@" 2>&1)"; then die "$what: succeeded, but it should have failed"; fi
  grep -Eq "$pattern" <<<"$out" || die "$what: failed, but without /$pattern/: $(tail -3 <<<"$out")"
  log "ok    $what fails with /$pattern/"
}

# issue_cash_token <issuer>: sets ADR-0003's issuer flags, then deploys the SAC of
# USD:<issuer>. Prints the SAC's contract ID.
issue_cash_token() {
  stellar tx new set-options -q --source-account "$1" \
    --set-required --set-revocable --set-clawback-enabled >/dev/null
  stellar contract asset deploy -q --source-account "$1" --asset "USD:$(addr "$1")"
}

# open_bank <issuer> <bank> <amount>: the bank opens a USD trustline, the issuer authorizes
# it and pays the bank <amount>, in stroops: the same units as the SAC and the contract.
open_bank() {
  local asset
  asset="USD:$(addr "$1")"
  stellar tx new change-trust -q --source-account "$2" --line "$asset" >/dev/null
  stellar tx new set-trustline-flags -q --source-account "$1" --trustor "$(addr "$2")" \
    --asset "$asset" --set-authorize >/dev/null
  stellar tx new payment -q --source-account "$1" --destination "$(addr "$2")" \
    --asset "$asset" --amount "$3" >/dev/null
}

# deploy_settlement <deployer> <sac>: deploys the settlement contract with the SAC as its
# cash token (ADR-0004). Prints its contract ID. The contract can't hold USD until
# authorize_holder runs.
deploy_settlement() {
  stellar contract deploy -q --source-account "$1" --wasm "$WASM" -- --token "$2"
}

# authorize_holder <issuer> <sac> <contract> <true|false>: the SAC admin sets whether the
# contract may hold and move USD.
authorize_holder() {
  invoke "$1" "$2" set_authorized --id "$3" --authorize "$4" >/dev/null
}

# deposit <bank> <contract> <amount>: the bank deposits into its settlement balance (A11).
# Prints the transaction hash, read from the CLI's log.
deposit() {
  local out
  out="$(stellar contract invoke --source-account "$1" --id "$2" -- \
    deposit --bank "$(addr "$1")" --amount "$3" 2>&1)" || { printf '%s\n' "$out" >&2; die "deposit($1, $3) failed"; }
  grep -Eo '[0-9a-f]{64}' <<<"$out" | head -1
}

# tx_ledger <hash>: polls getTransaction until the transaction is final (ADR-0005) and prints
# "<status> <ledger>".
tx_ledger() {
  local result status
  for _ in $(seq 1 30); do
    result="$(rpc getTransaction "{\"hash\":\"$1\"}")"
    status="$(jq -r .result.status <<<"$result")"
    [ "$status" != NOT_FOUND ] && { jq -r '"\(.result.status) \(.result.ledger)"' <<<"$result"; return; }
    sleep 1
  done
  die "transaction $1 not found"
}

# latest_ledger: the newest ledger's sequence number.
latest_ledger() { rpc getLatestLedger | jq -r .result.sequence; }

# contract_events <contract> <start-ledger>: the contract's events from getEvents, as JSON.
contract_events() {
  rpc getEvents "{\"startLedger\":$2,\"xdrFormat\":\"json\",
    \"filters\":[{\"type\":\"contract\",\"contractIds\":[\"$1\"]}],
    \"pagination\":{\"limit\":100}}"
}

# ledger_entry <ledger-key-json>: one entry from getLedgerEntries, as JSON (null if absent).
ledger_entry() {
  local key
  key="$(stellar xdr encode --type LedgerKey <<<"$1")"
  rpc getLedgerEntries "{\"keys\":[\"$key\"],\"xdrFormat\":\"json\"}" | jq -c '.result.entries[0]'
}

# balance_key <contract> <G-address>: the contract's persistent DataKey::Balance(bank).
balance_key() {
  printf '{"contract_data":{"contract":"%s","durability":"persistent","key":{"vec":[{"symbol":"Balance"},{"address":"%s"}]}}}' "$1" "$2"
}

# instance_key <contract>: the contract's instance entry.
instance_key() {
  printf '{"contract_data":{"contract":"%s","durability":"persistent","key":"ledger_key_contract_instance"}}' "$1"
}

# seq_num <G-address>: the account's sequence number.
seq_num() {
  ledger_entry "{\"account\":{\"account_id\":\"$1\"}}" | jq -r .dataJson.account.seq_num
}
