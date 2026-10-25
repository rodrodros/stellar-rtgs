#!/usr/bin/env bash
# Self-test of scripts/mutate.sh: a mutant the test catches is killed, even with the
# caller's PROPTEST_ settings exported; a no-op mutant survives; a patch that doesn't apply,
# a mutant that doesn't build, a filter matching several tests and a held lock are each an
# error; and the worktree is left as it was. `make mutate-selftest` runs it.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
lib=contracts/settlement/src/lib.rs
test=the_closure_leaves_every_queue_at_rest
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0
before=$(shasum "$lib")

# mutant <name> <perl substitution>: a patch of lib.rs, as `git diff` would write it.
mutant() {
  perl -0pe "$2" "$lib" >"$work/mutated.rs"
  if cmp -s "$lib" "$work/mutated.rs"; then echo "FAIL  $1: the substitution matched nothing"; fail=1; fi
  diff -u --label "a/$lib" --label "b/$lib" "$lib" "$work/mutated.rs" >"$work/$1.patch"
}
# expect <status> <line> <what> <mutate.sh argument>...: its exit status, and a line its
# output must hold.
expect() {
  local status=$1 line=$2 what=$3 out got
  shift 3
  out=$(scripts/mutate.sh "$@" 2>&1)
  got=$?
  if [ "$got" = "$status" ] && grep -qF -- "$line" <<<"$out"; then
    echo "ok    $what"
  else
    echo "FAIL  $what (exit $got)"
    echo "$out" | sed 's/^/      /'
    fail=1
  fi
}

# A submission that settles at once no longer runs the closure for its receiver (S9).
mutant no_closure 's/(settle\(&env, &mut payment, balance\);\n)\s*eager_closure\(&env, Vec::from_array\(&env, \[payment\.to\]\)\);\n/$1/'
expect 0 "no_closure  pinned: killed  seeds 1-2 killed: 2/2" "a mutant the test catches is killed" \
  --seeds 2 "$test" "$work/no_closure.patch"
# One case under one seed lets this mutant survive, so a leak would show.
PROPTEST_CASES=1 PROPTEST_RNG_SEED=1 \
  expect 0 "no_closure  pinned: killed  seeds 1-2 killed: 2/2" "the caller's PROPTEST_ settings are ignored" \
  --seeds 2 "$test" "$work/no_closure.patch"

mutant no_op 's/\z/\n\/\/ no-op mutant\n/'
expect 1 "no_op  pinned: survived  seeds 1-2 killed: 0/2" "a no-op mutant survives" \
  --seeds 2 "$test" "$work/no_op.patch"

sed 's/^-/-garbled /' "$work/no_closure.patch" >"$work/stale.patch"
expect 2 "stale: does not apply" "a patch that doesn't apply is an error" \
  --seeds 2 "$test" "$work/stale.patch"

mutant unviable 's/\z/\nfn unviable() -> u8 { "not a u8" }\n/'
expect 2 "unviable  unviable: does not build" "a mutant that doesn't build is an error" \
  --seeds 2 "$test" "$work/unviable.patch"

expect 2 "name exactly one" "a filter matching several tests is an error" \
  --seeds 2 tests::props:: "$work/no_op.patch"

mkdir -p target/mutate/lock && echo $$ >target/mutate/lock/pid
expect 2 "another mutate run (pid $$)" "a held lock is an error" --seeds 2 "$test" "$work/no_op.patch"
rm -rf target/mutate/lock

[ "$(shasum "$lib")" = "$before" ] || { echo "FAIL  the worktree's $lib changed"; fail=1; }
exit $fail
