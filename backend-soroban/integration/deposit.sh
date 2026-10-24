#!/usr/bin/env bash
# A11 (deposit: trustline -> the contract's sub-ledger, definition §5.5) on the local devnet,
# under ADR-0003's issuer flags. Checks S1, S4 and S6, ADR-0004 and ADR-0005, three ways:
# contract views, the RPC's getEvents, and getLedgerEntries (stored value and TTL).
# Two banks and three deposits, so S1 compares the contract's holding with a real sum and a
# deposit that overwrote instead of adding would fail (review H2).
# ADR-0013: no business day, so A11's phase=Open guard has no counterpart here.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

new_ids it-dep-issuer it-dep-bank1 it-dep-bank2
issuer=it-dep-issuer
b1="$(addr it-dep-bank1)"
b2="$(addr it-dep-bank2)"
sac="$(issue_cash_token "$issuer")"
open_bank "$issuer" it-dep-bank1 1000
open_bank "$issuer" it-dep-bank2 1000
contract="$(deploy_settlement it-dep-bank1 "$sac" "$(addr "$issuer")")"
authorize_holder "$issuer" "$sac" "$contract" true
log "cash token $sac, settlement $contract"
start="$(latest_ledger)"

first="$(deposit it-dep-bank1 "$contract" 100)"
deposit it-dep-bank1 "$contract" 200 >/dev/null
last="$(deposit it-dep-bank2 "$contract" 50)"

# ADR-0005: a deposit is final once its ledger closes.
# (tx_ledger runs on its own line: a die inside <<<"$(...)" or a pipe would not stop the script.)
first_tx="$(tx_ledger "$first")"
last_tx="$(tx_ledger "$last")"
read -r status first_ledger <<<"$first_tx"
check "first deposit's status" "$status" SUCCESS
check "last deposit's status" "${last_tx%% *}" SUCCESS

bal1="$(view it-dep-bank1 "$contract" balance --bank "$b1")"
bal2="$(view it-dep-bank1 "$contract" balance --bank "$b2")"
held="$(view it-dep-bank1 "$sac" balance --id "$contract")"
# S1: what the contract holds, read from the SAC, is the sum of the balances the contract
# reports. It is checked before the expected values, so a bookkeeping bug shows up as S1.
check "S1: USD held by the contract = balance(bank1) + balance(bank2)" "$held" $((bal1 + bal2))

# S4: each balance moved by exactly the amounts deposited, on both sides of the contract.
check "balance(bank1)" "$bal1" 300
check "balance(bank2)" "$bal2" 50
check "bank1's USD" "$(view it-dep-bank1 "$sac" balance --id "$b1")" 700
check "bank2's USD" "$(view it-dep-bank1 "$sac" balance --id "$b2")" 950
check "USD held by the contract" "$held" 350

# One `deposited` event per deposit, in order, with the bank as topic and the amount as data.
events="$(contract_events "$contract" "$start")"
check "deposited events" "$(jq -r '[.result.events[]
  | select(.topicJson[0].symbol == "deposited")
  | "\(.topicJson[1].address):\(.valueJson.map[] | select(.key.symbol == "amount") | .val.i128)"]
  | join(" ")' <<<"$events")" "$b1:100 $b1:200 $b2:50"

# Storage as the network holds it. The first write extends each entry to BUMP_AMOUNT ledgers;
# later writes leave it, because it stays above the threshold.
entry="$(ledger_entry "$(balance_key "$contract" "$b1")")"
check "stored Balance(bank1)" "$(jq -r .dataJson.contract_data.val.i128 <<<"$entry")" 300
check "Balance(bank1) live-until minus its first write" \
  "$(( $(jq -r .liveUntilLedgerSeq <<<"$entry") - first_ledger ))" "$BUMP_AMOUNT"
entry="$(ledger_entry "$(instance_key "$contract")")"
check "instance live-until minus the first deposit" \
  "$(( $(jq -r .liveUntilLedgerSeq <<<"$entry") - first_ledger ))" "$BUMP_AMOUNT"

log "PASS deposit"
