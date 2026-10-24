#!/usr/bin/env bash
# Self-test of scripts/check-traces.sh (SC-MB-05): it must pass on matching trace sets, and
# fail on an edited trace, a deleted one and an extra one. `make quint` runs it.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
check=scripts/check-traces.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0

# fresh <dir>: a copy of the first two committed traces.
fresh() { rm -rf "$1"; mkdir -p "$1"; cp quint/traces/trace0.itf.json quint/traces/trace1.itf.json "$1/"; }
# expect <0|1> <what>: the check's exit status, 0 for pass and 1 for any failure.
expect() {
  "$check" "$work/committed" "$work/regen" >/dev/null 2>&1
  local got=$(( $? != 0 ))
  if [ "$got" = "$1" ]; then echo "ok    $2"; else echo "FAIL  $2"; fail=1; fi
}

fresh "$work/committed"; fresh "$work/regen"
expect 0 "matching traces pass"

jq '.states[1].now = {"#bigint": "999"}' "$work/regen/trace1.itf.json" >"$work/committed/trace1.itf.json"
expect 1 "an edited trace fails"

fresh "$work/committed"; rm "$work/committed/trace1.itf.json"
expect 1 "a deleted trace fails"

fresh "$work/committed"; cp "$work/committed/trace0.itf.json" "$work/committed/trace7.itf.json"
expect 1 "an extra trace fails"

exit $fail
