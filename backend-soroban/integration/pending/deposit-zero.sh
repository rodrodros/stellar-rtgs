#!/usr/bin/env bash
# PENDING (red until the contract guards its amounts). A11's guard requires x > 0 (definition
# §4; S4: a balance changes only by a real action). The settlement contract must refuse a
# deposit of 0 or less itself, with its own error, before it calls the SAC: nothing moves and
# no `deposited` event is published.
# Today a zero deposit succeeds and publishes `deposited` with amount 0, and a negative one
# fails only inside the SAC's transfer. The contract's error isn't defined yet: when its
# #[contracterror] lands, replace the "not from the SAC" check below with its code, then
# move this file up into integration/.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

new_ids it-zero-issuer it-zero-bank
issuer=it-zero-issuer
bank="$(addr it-zero-bank)"
sac="$(issue_cash_token "$issuer")"
open_bank "$issuer" it-zero-bank 1000
contract="$(deploy_settlement it-zero-bank "$sac")"
authorize_holder "$issuer" "$sac" "$contract" true
start="$(latest_ledger)"

for amount in 0 -5; do
  out="$(stellar contract invoke --source-account it-zero-bank --id "$contract" -- \
    deposit --bank "$bank" --amount "$amount" 2>&1)" && die "deposit($amount) succeeded; it should be refused"
  grep -q 'Error(Contract, #' <<<"$out" || die "deposit($amount) failed without a contract error: $(tail -2 <<<"$out")"
  # A refusal by the SAC's transfer means the contract never checked the amount itself.
  grep -q '"contract call failed", transfer' <<<"$out" && die "deposit($amount) was refused by the SAC, not by the settlement contract"
  log "ok    deposit($amount) refused by the settlement contract"
done

check "balance(bank)" "$(view it-zero-bank "$contract" balance --bank "$bank")" 0
check "USD held by the contract" "$(view it-zero-bank "$sac" balance --id "$contract")" 0
check "deposited events" "$(contract_events "$contract" "$start" |
  jq '[.result.events[] | select(.topicJson[0].symbol == "deposited")] | length')" 0

log "PASS deposit-zero"
