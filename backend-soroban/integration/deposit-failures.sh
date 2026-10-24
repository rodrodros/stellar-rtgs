#!/usr/bin/env bash
# A11's failures on the local devnet, under ADR-0003's issuer flags. Each one fails in
# simulation, so the CLI never submits it: no fee is charged and the sequence number is not
# used (C-HB-162, C-HB-163), and S1 and S4 hold because nothing moves.
#   - an overdraw: the SAC refuses it (Error(Contract, #10));
#   - a frozen bank (trustline deauthorized by the issuer): Error(Contract, #11);
#   - a contract the issuer has not yet authorized as a holder: Error(Contract, #11).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

new_ids it-fail-issuer it-fail-bank it-fail-frozen
issuer=it-fail-issuer
bank="$(addr it-fail-bank)"
frozen="$(addr it-fail-frozen)"
sac="$(issue_cash_token "$issuer")"
open_bank "$issuer" it-fail-bank 1000
open_bank "$issuer" it-fail-frozen 1000
contract="$(deploy_settlement it-fail-bank "$sac")"

# unchanged <what>: no balance moved and the bank's sequence number is the one before.
unchanged() {
  check "$1: balance(bank)" "$(view it-fail-bank "$contract" balance --bank "$bank")" "$2"
  check "$1: bank's USD" "$(view it-fail-bank "$sac" balance --id "$bank")" "$3"
  check "$1: USD held by the contract" "$(view it-fail-bank "$sac" balance --id "$contract")" "$2"
  check "$1: bank's sequence number" "$(seq_num "$bank")" "$seq"
}

seq="$(seq_num "$bank")"
expect_fail "deposit before the contract is an authorized holder" 'Error\(Contract, #11\)' \
  stellar contract invoke --source-account it-fail-bank --id "$contract" -- deposit --bank "$bank" --amount 100
unchanged "after the refused deposit" 0 1000

authorize_holder "$issuer" "$sac" "$contract" true
deposit it-fail-bank "$contract" 400 >/dev/null

seq="$(seq_num "$bank")"
expect_fail "deposit of more than the trustline holds" 'Error\(Contract, #10\)' \
  stellar contract invoke --source-account it-fail-bank --id "$contract" -- deposit --bank "$bank" --amount 601
unchanged "after the overdraw" 400 600

stellar tx new set-trustline-flags -q --source-account "$issuer" --trustor "$frozen" \
  --asset "USD:$(addr "$issuer")" --clear-authorize >/dev/null
expect_fail "deposit by a frozen bank" 'Error\(Contract, #11\)' \
  stellar contract invoke --source-account it-fail-frozen --id "$contract" -- deposit --bank "$frozen" --amount 100
check "balance(frozen bank)" "$(view it-fail-bank "$contract" balance --bank "$frozen")" 0
check "S1: USD held by the contract = balance(bank)" "$(view it-fail-bank "$sac" balance --id "$contract")" 400

log "PASS deposit-failures"
