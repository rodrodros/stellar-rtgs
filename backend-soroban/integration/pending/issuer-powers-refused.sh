#!/usr/bin/env bash
# PENDING (red until the issuance controller lands). The correct behaviour behind the known
# hazard in integration/issuer-powers-hazard.sh (review H1; S1, L1, L3; ADR-0003, ADR-0006):
# nobody can claw back from or freeze the settlement contract's pooled holding outside the
# contract's own recorded path. So:
#   - a direct SAC clawback(contract, 100) by the issuer is refused, and S1 still holds;
#   - a direct SAC set_authorized(contract, false) by the issuer is refused, and deposits
#     still settle.
# Each call is submitted with the issuer's signature only (send_as), so the network does the
# refusing, not the CLI. Today the issuer is the SAC admin, so both succeed, and this is red
# at the first check.
# The fix moves the SAC admin to an issuance controller (rtgs-mapping.md §2). When it lands,
# lib.sh's setup must hand the admin role to the controller, and this scenario should then
# pass. Move it up into integration/, and delete issuer-powers-hazard.sh, which will then fail.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

new_ids it-ref-issuer it-ref-bank
issuer=it-ref-issuer
bank="$(addr it-ref-bank)"
sac="$(issue_cash_token "$issuer")"
open_bank "$issuer" it-ref-bank 1000
contract="$(deploy_settlement it-ref-bank "$sac")"
authorize_holder "$issuer" "$sac" "$contract" true
deposit it-ref-bank "$contract" 600 >/dev/null

expect_fail "direct SAC clawback from the settlement contract" 'invalid_action|InvalidAction' \
  send_as "$issuer" "$sac" clawback --from "$contract" --amount 100
held="$(view it-ref-bank "$sac" balance --id "$contract")"
recorded="$(view it-ref-bank "$contract" balance --bank "$bank")"
check "S1 after the refused clawback: USD held by the contract = balance(bank)" "$held" "$recorded"

expect_fail "direct SAC freeze of the settlement contract" 'invalid_action|InvalidAction' \
  send_as "$issuer" "$sac" set_authorized --id "$contract" --authorize false
deposit it-ref-bank "$contract" 100 >/dev/null
check "balance(bank) after a deposit following the refused freeze" "$(view it-ref-bank "$contract" balance --bank "$bank")" 700
check "S1: USD held by the contract = balance(bank)" "$(view it-ref-bank "$sac" balance --id "$contract")" 700

log "PASS issuer-powers-refused"
