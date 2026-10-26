#!/usr/bin/env bash
# pnpm simulate:supervised [simulate flags]
# Keeps the simulation running on a hosted devnet: runs `pnpm simulate` with these flags and
# starts it again whenever it exits, whether it crashed, couldn't reach the RPC at start, or
# finished a --duration (so --duration recycles the process on a schedule). A signal (Ctrl-C or
# SIGTERM, e.g. `docker stop`) stops the simulation gracefully and the supervisor with it.
set -uo pipefail

sim="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tsx="$sim/node_modules/.bin/tsx"
[[ -x "$tsx" ]] || { echo "supervise: $tsx not found; run pnpm install first" >&2; exit 1; }

log() { printf '%s supervise: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# Its own process group (job control), so a Ctrl-C reaches only this script, which then asks
# the simulation to stop once: a second signal would make the simulator force-quit.
set -m

child=""
stopping=0
on_signal() {
  stopping=1
  if [[ -n "$child" ]]; then
    log "stopping the simulation (pid $child)"
    kill -TERM "$child" 2>/dev/null
  fi
}
trap on_signal INT TERM

delay=10
while true; do
  started=$SECONDS
  (cd "$sim" && exec "$tsx" src/cli.ts "$@") &
  child=$!
  log "simulation started (pid $child)"
  # `wait` returns early when a signal arrives; wait again until the simulation has drained.
  wait "$child"
  code=$?
  while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    code=$?
  done
  child=""
  if (( stopping )); then
    log "stopped"
    exit 0
  fi
  # A run that lasted a while resets the back-off; one that keeps failing at once backs off to a minute.
  (( SECONDS - started > 300 )) && delay=10
  log "simulation exited with code $code after $((SECONDS - started))s; restarting in ${delay}s"
  sleep "$delay" &
  wait $! || true
  (( stopping )) && { log "stopped"; exit 0; }
  delay=$(( delay * 2 > 60 ? 60 : delay * 2 ))
done
