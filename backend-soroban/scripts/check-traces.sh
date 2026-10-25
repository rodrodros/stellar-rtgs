#!/usr/bin/env bash
# check-traces.sh <committed-dir> <regenerated-dir>: fails unless both directories hold the
# same set of *.itf.json traces with the same states. `make quint` runs it on quint/traces
# and a fresh regeneration; scripts/check-traces-selftest.sh tests it.
set -uo pipefail
committed=$1
regen=$2
stale=0
names() { (cd "$1" && ls -1 -- *.itf.json 2>/dev/null) | sort; }

while read -r f; do
  echo "missing: $committed/$f (run make quint-traces)"; stale=1
done < <(comm -13 <(names "$committed") <(names "$regen"))
while read -r f; do
  echo "extra: $committed/$f (run make quint-traces)"; stale=1
done < <(comm -23 <(names "$committed") <(names "$regen"))
while read -r f; do
  diff <(jq -S .states "$committed/$f") <(jq -S .states "$regen/$f") >/dev/null ||
    { echo "stale: $committed/$f (run make quint-traces)"; stale=1; }
done < <(comm -12 <(names "$committed") <(names "$regen"))
exit $stale
