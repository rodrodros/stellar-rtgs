# Shared settings and helpers for the devnet scripts. Source this file; don't run it.
# Adapted from stellar-research/handbook/lab/common.sh.

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The pinned quickstart image (handbook 01-toolchain.md). Containers are named impl-*.
IMPL_IMAGE="${IMPL_IMAGE:-stellar/quickstart:v678-b1525.1-latest}"
IMPL_NAME="${IMPL_NAME:-impl-local}"
IMPL_PORT="${IMPL_PORT:-8300}"
IMPL_URL="http://localhost:$IMPL_PORT"
IMPL_PASSPHRASE="Standalone Network ; February 2017"

# stellar-cli keeps its identities and aliases in the repo, not in ~/.config (gitignored).
export XDG_CONFIG_HOME="$repo/.devnet"
export STELLAR_RPC_URL="$IMPL_URL/rpc"
export STELLAR_NETWORK_PASSPHRASE="$IMPL_PASSPHRASE"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# rpc <method> [params-json]: one JSON-RPC 2.0 call to the local RPC; prints the response.
rpc() {
  local body
  body="$(jq -nc --arg m "$1" --argjson p "${2:-null}" \
    '{jsonrpc: "2.0", id: 1, method: $m} + (if $p == null then {} else {params: $p} end)')"
  curl -s -m 10 -X POST -H 'Content-Type: application/json' -d "$body" "$IMPL_URL/rpc"
}

# wait_until <timeout-s> <what> <command...>: poll every second until the command succeeds.
wait_until() {
  local timeout="$1" what="$2" start=$SECONDS
  shift 2
  until "$@" >/dev/null 2>&1; do
    (( SECONDS - start >= timeout )) && { log "timeout after ${timeout}s waiting for: $what"; return 1; }
    sleep 1
  done
  log "$what after $((SECONDS - start))s"
}

rpc_healthy() { rpc getHealth | jq -e '.result.status == "healthy"'; }
at_protocol() { rpc getNetwork | jq -e ".result.protocolVersion == $1"; }
# Friendbot answers a request without an address with an invalid_field error.
friendbot_up() { curl -s -m 5 "$IMPL_URL/friendbot" | grep -q invalid_field; }

# fund <identity>: through the friendbot on our port. `stellar keys fund` would use the
# URL RPC advertises, which points at the container's port 8000 (C-HB-073).
fund() {
  curl -sf -m 30 "$IMPL_URL/friendbot?addr=$(stellar keys public-key "$1")" >/dev/null || die "friendbot could not fund $1"
}
