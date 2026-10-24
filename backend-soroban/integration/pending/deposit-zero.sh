#!/usr/bin/env bash
# PENDING (red until the contract guards its amounts). A11's guard requires x > 0 (definition
# §4; S4: a balance changes only by a real action). The settlement contract must refuse a
# deposit of 0 or less itself, with its own error, before it calls the SAC: nothing moves and
# no `deposited` event is published.
# ADR-0013: no business day, so A11's phase=Open guard has no counterpart here; x > 0 stays.
#
# Today a zero deposit succeeds and publishes `deposited` with amount 0, and a negative one
# fails only inside the SAC's transfer. The checks read the RPC's simulateTransaction, not
# the CLI's wording: the diagnostic events must hold an error raised by the settlement
# contract and no event at all from the SAC, which proves the SAC was never called. When the
# contract's #[contracterror] lands, also check its code here, then move this file up into
# integration/.
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
  tx="$(stellar contract invoke -q --build-only --source-account it-zero-bank --id "$contract" -- \
    deposit --bank "$bank" --amount "$amount")"
  sim="$(rpc simulateTransaction "{\"transaction\":\"$tx\",\"xdrFormat\":\"json\"}")"
  [ "$(jq -r '.result.error // empty' <<<"$sim")" ] || die "deposit($amount) simulates successfully; it should be refused"
  check "deposit($amount): diagnostic events from the SAC" \
    "$(jq --arg sac "$sac" '[.result.eventsJson[]? | select(.event.contract_id == $sac)] | length' <<<"$sim")" 0
  check "deposit($amount): a contract error raised by the settlement contract" \
    "$(jq --arg c "$contract" '[.result.eventsJson[]? | select(.event.contract_id == $c)
      | select(.event.body.v0.topics[0].symbol == "error" and .event.body.v0.topics[1].error.contract != null)]
      | length > 0' <<<"$sim")" true
done

check "balance(bank)" "$(view it-zero-bank "$contract" balance --bank "$bank")" 0
check "USD held by the contract" "$(view it-zero-bank "$sac" balance --id "$contract")" 0
check "deposited events" "$(contract_events "$contract" "$start" |
  jq '[.result.events[] | select(.topicJson[0].symbol == "deposited")] | length')" 0

log "PASS deposit-zero"
