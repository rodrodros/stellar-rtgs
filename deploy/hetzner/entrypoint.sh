#!/usr/bin/env bash
# The simulator container's entry point: waits for the devnet's RPC, bootstraps the deployment
# (idempotent, so a restart only checks it, and a wiped ledger gets a new one), then hands over
# to supervise.sh, which keeps the simulation running. Flags are passed on to the simulator.
set -euo pipefail

banks="${SIM_BANKS:-3}"
log() { printf '%s entrypoint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

log "waiting for $RTGS_DEVNET_RPC_URL"
until node -e '
  fetch(process.env.RTGS_DEVNET_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  })
    .then((r) => r.json())
    .then((j) => process.exit(j.result?.status === "healthy" ? 0 : 1), () => process.exit(1));
'; do sleep 5; done

# Friendbot comes up a little after RPC; the bootstrap retries are cheap, so loop until it succeeds.
until pnpm --silent devnet:bootstrap --banks "$banks"; do
  log "bootstrap failed; retrying in 15s"
  sleep 15
done

exec bash apps/simulator/scripts/supervise.sh --banks "$banks" "$@"
