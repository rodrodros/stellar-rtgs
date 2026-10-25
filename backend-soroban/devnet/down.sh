#!/usr/bin/env bash
# Stop and remove the local network. Its ledger, and the identities smoke.sh made, are thrown away.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if docker ps -a --format '{{.Names}}' | grep -qx "$IMPL_NAME"; then
  docker rm -f "$IMPL_NAME" >/dev/null
  log "down: removed $IMPL_NAME"
else
  log "down: $IMPL_NAME is not running"
fi
rm -rf "$XDG_CONFIG_HOME"
