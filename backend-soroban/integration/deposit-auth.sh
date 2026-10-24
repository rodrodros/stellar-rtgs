#!/usr/bin/env bash
# A11 under S6 on the local devnet, with real signatures: only the bank can authorize a
# deposit out of its trustline (ADR-0004). Simulation shows whose authorization the call
# needs; a sender holding only its own key can't make it, and nothing moves.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

new_ids it-auth-issuer it-auth-bank it-auth-other
issuer=it-auth-issuer
bank="$(addr it-auth-bank)"
sac="$(issue_cash_token "$issuer")"
open_bank "$issuer" it-auth-bank 1000
contract="$(deploy_settlement it-auth-other "$sac")"
authorize_holder "$issuer" "$sac" "$contract" true

# Simulation records every require_auth: deposit(bank, 1) needs the bank, and only the bank,
# even when another account sends it.
tx="$(stellar contract invoke -q --build-only --source-account it-auth-other --id "$contract" -- \
  deposit --bank "$bank" --amount 1)"
sim="$(rpc simulateTransaction "{\"transaction\":\"$tx\",\"xdrFormat\":\"json\"}")"
check "accounts that must authorize deposit(bank, 1)" \
  "$(jq -c '[.result.results[0].authJson[]?.credentials.address.address]' <<<"$sim")" "[\"$bank\"]"

# The other account's secret alone, in an empty key store, so the CLI has no key for the bank.
other_secret="$(stellar keys show it-auth-other)"
empty="$(mktemp -d)"
expect_fail "deposit(bank, 1) sent by another account" "Missing signing key for account $bank" \
  env XDG_CONFIG_HOME="$empty" stellar contract invoke --source-account "$other_secret" \
  --id "$contract" -- deposit --bank "$bank" --amount 1
rm -rf "$empty"

check "balance(bank) after the refused deposit" "$(view it-auth-bank "$contract" balance --bank "$bank")" 0
check "bank's USD after the refused deposit" "$(view it-auth-bank "$sac" balance --id "$bank")" 1000
check "USD held by the contract" "$(view it-auth-bank "$sac" balance --id "$contract")" 0

log "PASS deposit-auth"
