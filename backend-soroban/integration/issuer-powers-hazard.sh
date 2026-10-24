#!/usr/bin/env bash
# KNOWN HAZARD (review H1; S1, L1, L3; ADR-0003, ADR-0006). This scenario pins today's
# behaviour, which is wrong, so that it can't be forgotten.
#
# ADR-0003's flags give the issuer, as the SAC admin, two powers over the settlement
# contract's pooled holding that bypass the contract:
#   - clawback(contract, x) takes x out of the contract. The contract still records every
#     bank's balance, so the sum of its balances exceeds what it holds and S1 breaks. It can't
#     tell which bank lost the money, and it is not the model's A16.
#   - set_authorized(contract, false) freezes the contract, so every later deposit fails and
#     the whole RTGS stops (L1, L3).
#
# The fix is a design change: an issuance controller holds the SAC admin role and refuses
# both on the settlement contract outside a recorded A16 path (rtgs-mapping.md §2). When it
# lands, this scenario must fail. Then flip its assertions: the clawback and the freeze are
# refused, and S1 holds.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

log "KNOWN HAZARD: expected to fail once the issuance controller lands; flip the assertions then"
new_ids it-haz-issuer it-haz-bank
issuer=it-haz-issuer
bank="$(addr it-haz-bank)"
sac="$(issue_cash_token "$issuer")"
open_bank "$issuer" it-haz-bank 1000
contract="$(deploy_settlement it-haz-bank "$sac")"
authorize_holder "$issuer" "$sac" "$contract" true
deposit it-haz-bank "$contract" 600 >/dev/null
check "S1 before: USD held by the contract = balance(bank)" "$(view it-haz-bank "$sac" balance --id "$contract")" 600

invoke "$issuer" "$sac" clawback --from "$contract" --amount 100 >/dev/null
held="$(view it-haz-bank "$sac" balance --id "$contract")"
recorded="$(view it-haz-bank "$contract" balance --bank "$bank")"
check "USD held by the contract after a direct clawback" "$held" 500
check "balance(bank) after a direct clawback" "$recorded" 600
check "HAZARD: S1 broken (held - sum of balances)" "$((held - recorded))" -100

authorize_holder "$issuer" "$sac" "$contract" false
expect_fail "HAZARD: deposit into a frozen contract" 'Error\(Contract, #11\)' \
  stellar contract invoke --source-account it-haz-bank --id "$contract" -- deposit --bank "$bank" --amount 100

log "PASS issuer-powers-hazard (the hazard is still there)"
