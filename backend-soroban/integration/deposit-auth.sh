#!/usr/bin/env bash
# A11 under S6 on the local devnet, with real signatures: only the bank can authorize a
# deposit out of its trustline (ADR-0004).
#   1. Simulation shows whose authorization the call needs: the bank's, and only the bank's.
#   2. Another account signs and submits deposit(bank, 1) itself. The network refuses it at
#      the bank's require_auth (Error(Auth, InvalidAction)) and nothing moves. Unlike the
#      checks in deposit-failures.sh this one is submitted, so the sender pays the
#      fee and uses its sequence number (C-HB-162, C-HB-163).
# ADR-0013: no business day, so A11's phase=Open guard has no counterpart here.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

new_ids it-auth-issuer it-auth-bank it-auth-other
issuer=it-auth-issuer
bank="$(addr it-auth-bank)"
other="$(addr it-auth-other)"
sac="$(issue_cash_token "$issuer")"
open_bank "$issuer" it-auth-bank 1000
contract="$(deploy_settlement it-auth-other "$sac" "$(addr "$issuer")")"
authorize_holder "$issuer" "$sac" "$contract" true

# 1. Simulation records every require_auth. A simulation that fails also yields no auth
# entries, so check that it succeeded before reading them.
tx="$(stellar contract invoke -q --build-only --source-account it-auth-other --id "$contract" -- \
  deposit --bank "$bank" --amount 1)"
sim="$(rpc simulateTransaction "{\"transaction\":\"$tx\",\"xdrFormat\":\"json\"}")"
check "simulation of deposit(bank, 1) sent by another account: error" "$(jq -r '.result.error // "none"' <<<"$sim")" none
check "accounts that must authorize deposit(bank, 1)" \
  "$(jq -c '[.result.results[0].authJson[]?.credentials.address.address]' <<<"$sim")" "[\"$bank\"]"

# 2. The other account signs the envelope with its own key and submits; nobody signs the
# bank's authorization entry.
account() { ledger_entry "{\"account\":{\"account_id\":\"$other\"}}" | jq -r ".dataJson.account.$1"; }
seq_before="$(account seq_num)"
xlm_before="$(account balance)"
expect_fail "deposit(bank, 1) signed and submitted by another account" 'invalid_action|InvalidAction' \
  send_as it-auth-other "$contract" deposit --bank "$bank" --amount 1

check "balance(bank) after the refused deposit" "$(view it-auth-bank "$contract" balance --bank "$bank")" 0
check "bank's USD after the refused deposit" "$(view it-auth-bank "$sac" balance --id "$bank")" 1000
check "USD held by the contract" "$(view it-auth-bank "$sac" balance --id "$contract")" 0
check "sender's sequence number: used by the failed transaction" "$(account seq_num)" $((seq_before + 1))
xlm_after="$(account balance)"
[ "$xlm_after" -lt "$xlm_before" ] || die "the failed transaction charged no fee: $xlm_before -> $xlm_after"
log "ok    the failed transaction charged a fee of $((xlm_before - xlm_after)) stroops"

log "PASS deposit-auth"
