#!/usr/bin/env bash
# Hand mutants (TESTING.md, "Hand mutants"): runs one test against each mutant, under the
# pinned seed and seeds 1 to N, and reports whether it kills each one.
#
#   scripts/mutate.sh [--seeds N] [--package P] [--timeout SECS] <test filter> <mutant.patch>...
#
# A mutant is a patch against the worktree, as `git diff` writes it. The script mutates a
# copy in target/mutate/src, built into target/mutate/target, so the worktree is never
# edited and its own target/ stays free for other cargo commands. One run at a time holds
# target/mutate. Each run is the test binary itself, all seeds in parallel, with shrinking
# off: a sweep needs killed or survived, not a minimal case. A run killed by its timeout
# (by default ten times the baseline's, at least 60 s) is reported apart, not as a kill.
#
# Exit status, the first that applies: 2 on a usage error, a held lock, a baseline that
# fails, or a mutant that doesn't apply, doesn't build or whose test never ran; 1 when a
# mutant survives under any seed, pinned or not; 3 when a run timed out; 0 when every
# mutant is killed under every seed; 130 when interrupted.
set -euo pipefail
caller=$PWD
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  sed -n '5p' "${BASH_SOURCE[0]}" | sed 's/^#  */usage: /' >&2
  exit 2
}
seeds=4
package=settlement
timeout=""
while [ $# -gt 0 ]; do
  case $1 in --seeds | --package | --timeout) [ $# -ge 2 ] || usage ;; esac
  case $1 in
    --seeds) seeds=$2; shift 2 ;;
    --package) package=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || usage
case $seeds in '' | *[!0-9]* | 0) usage ;; esac
case $timeout in *[!0-9]* | 0) usage ;; esac
for tool in jq rsync perl; do
  command -v "$tool" >/dev/null || { echo "mutate.sh needs $tool" >&2; exit 2; }
done
filter=$1
shift
patches=()
for patch in "$@"; do
  case $patch in /*) patches+=("$patch") ;; *) patches+=("$caller/$patch") ;; esac
done

root=$PWD
work=$root/target/mutate
src=$work/src
lock=$work/lock
export CARGO_TARGET_DIR=$work/target
mkdir -p "$work"
if ! mkdir "$lock" 2>/dev/null; then
  holder=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -z "$holder" ] || kill -0 "$holder" 2>/dev/null; then
    echo "another mutate run (pid ${holder:-unknown}) holds $lock; wait for it, or remove the lock if it is stale" >&2
    exit 2
  fi
  rm -rf "$lock"
  mkdir "$lock"
fi
echo $$ >"$lock/pid"
trap 'rm -rf "$lock"' EXIT
# A step that fails unexpectedly is an error, not the "survived" status 1.
trap 'exit 2' ERR
# Background jobs ignore SIGINT in a script, so stop them, and the test each one runs, here.
stop() {
  trap - INT TERM
  for job in $(jobs -p); do
    pkill -P "$job" 2>/dev/null || true
    kill "$job" 2>/dev/null || true
  done
  exit 130
}
trap stop INT TERM
rm -rf "$work/runs"
mkdir -p "$src"

# Checksums, not times: a file reset to an older mtime than its build output would leave
# cargo running the last mutant's binary.
sync_copy() {
  rsync -r --checksum --delete --exclude /target --exclude /.git --exclude test_snapshots \
    --exclude quint-regen "$root/" "$src/"
}

# The test binary of $package in the copy, built as it now stands; nothing when it doesn't
# build. The compiler's messages go to build.log.
build() {
  (cd "$src" && cargo test -p "$package" --locked --no-run --message-format=json \
    >"$work/build.json" 2>"$work/build.err") || true
  { jq -r 'select(.reason == "compiler-message") | .message.rendered' "$work/build.json"
    cat "$work/build.err"; } >"$work/build.log"
  jq -r 'select(.reason == "compiler-artifact" and .profile.test and .executable != null) | .executable' \
    "$work/build.json" | sed -n 1p
}

# run <binary> <seed|pinned> <out>: one run, killed after $timeout seconds. Writes its exit
# status to <out>.status. The caller's PROPTEST_RNG_SEED and PROPTEST_CASES never reach
# it, so "pinned" is the seed and case count `make test` uses.
run() {
  local seed_env=() status=0
  [ "$2" = pinned ] || seed_env=(PROPTEST_RNG_SEED="$2")
  cd "$package_dir"
  env -u PROPTEST_RNG_SEED -u PROPTEST_CASES ${seed_env[@]+"${seed_env[@]}"} \
    PROPTEST_MAX_SHRINK_ITERS=0 \
    perl -e 'alarm shift; exec @ARGV or exit 3' "$timeout" "$1" "$filter" >"$3" 2>&1 || status=$?
  echo "$status" >"$3.status"
}

# sweep <binary> <dir>: the pinned seed and seeds 1 to $seeds in parallel, one output per run.
sweep() {
  rm -rf "$2"
  mkdir -p "$2"
  # The verdicts report a run that dies of a signal; its shell's own notice would repeat it.
  run "$1" pinned "$2/pinned" 2>/dev/null &
  for seed in $(seq 1 "$seeds"); do run "$1" "$seed" "$2/$seed" 2>/dev/null & done
  wait
}

# verdict <out>: survived (the one test passed), killed (it failed, or the test crashed:
# SIGILL to SIGSEGV but SIGKILL, as on a stack overflow), timeout, or error (anything
# else: it never ran, or something outside the test killed it).
verdict() {
  local status
  status=$(cat "$1.status")
  if [ "$status" = 0 ] && grep -q '^test result: ok\. 1 passed' "$1"; then
    echo survived
  elif [ "$status" = 142 ]; then
    echo timeout
  elif [ "$status" = 101 ] && grep -q '^test result: FAILED' "$1"; then
    echo killed
  elif [ "$status" -ge 132 ] && [ "$status" -le 139 ] && [ "$status" != 137 ]; then
    echo killed
  else
    echo error
  fi
}

sync_copy
binary=$(build || true)
if [ -z "$binary" ]; then
  echo "baseline: the copy does not build:" >&2
  tail -40 "$work/build.log" >&2
  exit 2
fi
# Each run starts in the package's directory, as under `cargo test`.
package_dir=$(jq -r 'select(.reason == "compiler-artifact" and .profile.test and .executable != null) | .manifest_path' \
  "$work/build.json" | sed -n 1p)
package_dir=${package_dir%/Cargo.toml}
baseline_timeout=${timeout:-600}
given_timeout=$timeout
timeout=$baseline_timeout
start=$SECONDS
sweep "$binary" "$work/runs/baseline"
elapsed=$((SECONDS - start))
for out in "$work/runs/baseline"/*.status; do
  log=${out%.status}
  matched=$(sed -n 's/^running \([0-9]*\) tests*$/\1/p' "$log" | head -1)
  if [ -n "$matched" ] && [ "$matched" != 1 ]; then
    echo "baseline: $filter matches $matched tests; name exactly one" >&2
    exit 2
  fi
  if [ "$(verdict "$log")" != survived ]; then
    echo "baseline: $filter does not pass unmutated under seed $(basename "$log"):" >&2
    tail -20 "$log" >&2
    exit 2
  fi
done
timeout=${given_timeout:-$((elapsed * 10 > 60 ? elapsed * 10 : 60))}
echo "baseline: $filter passes under the pinned seed and seeds 1-$seeds ($elapsed s a sweep; timeout $timeout s)"

any_error=0
any_survived=0
any_timeout=0
for patch in ${patches[@]+"${patches[@]}"}; do
  name=$(basename "$patch" .patch)
  sync_copy
  # The ceiling stops git from finding the worktree's repository above the copy.
  if ! GIT_CEILING_DIRECTORIES=$work git -C "$src" apply "$patch"; then
    echo "$name: does not apply" >&2
    any_error=1
    continue
  fi
  binary=$(build || true)
  if [ -z "$binary" ]; then
    echo "$name  unviable: does not build" >&2
    tail -40 "$work/build.log" | sed 's/^/    /' >&2
    any_error=1
    continue
  fi
  sweep "$binary" "$work/runs/$name"
  pinned=$(verdict "$work/runs/$name/pinned")
  killed=0
  others=""
  timed_out=0 errors=0
  for out in "$work/runs/$name"/*.status; do
    result=$(verdict "${out%.status}")
    case $result in
      survived) any_survived=1 ;;
      timeout) any_timeout=1 ;;
      error) any_error=1 ;;
    esac
    [ "$(basename "$out")" = pinned.status ] && continue
    case $result in
      killed) killed=$((killed + 1)) ;;
      timeout) timed_out=$((timed_out + 1)) ;;
      error) errors=$((errors + 1)) ;;
    esac
  done
  [ $timed_out = 0 ] || others="$others, $timed_out timed out"
  [ $errors = 0 ] || others="$others, $errors never ran"
  echo "$name  pinned: $pinned  seeds 1-$seeds killed: $killed/$seeds${others:+  (${others#, })}"
done
sync_copy
echo "outputs: $work/runs/<mutant>/<seed>"
if [ $any_error = 1 ]; then exit 2; fi
if [ $any_survived = 1 ]; then exit 1; fi
if [ $any_timeout = 1 ]; then exit 3; fi
exit 0
