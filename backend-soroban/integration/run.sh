#!/usr/bin/env bash
# Runs every integration scenario against the network from `make devnet-up`.
#   integration/*.sh          must pass; the first failure stops the run, which exits 1.
#   integration/pending/*.sh  are written test-first, for behaviour the contract doesn't have
#                             yet. They are reported as PENDING (red) and don't fail the run;
#                             with --strict they do. One that passes should be moved up.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
strict=false
[ "${1:-}" = --strict ] && strict=true

failed=0
for s in "$here"/*.sh; do
  case "$(basename "$s")" in lib.sh | run.sh) continue ;; esac
  echo "== $(basename "$s")"
  "$s" || { echo "FAIL: integration/$(basename "$s")"; exit 1; }
done

for s in "$here"/pending/*.sh; do
  [ -e "$s" ] || continue
  name="pending/$(basename "$s")"
  echo "== $name"
  if "$s"; then
    echo "NOW PASSES: integration/$name; move it up into integration/"
  else
    echo "PENDING (red): integration/$name"
    failed=1
  fi
done

if $strict && [ "$failed" = 1 ]; then echo "FAIL: pending scenarios are red (--strict)"; exit 1; fi
echo "integration: ok"
