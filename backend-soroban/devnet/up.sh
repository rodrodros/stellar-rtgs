#!/usr/bin/env bash
# Start the local network: one quickstart container in local mode at protocol 29, with
# testnet Soroban limits, core and RPC only, as $IMPL_NAME on 127.0.0.1:$IMPL_PORT.
# Waits until RPC is healthy, protocol 29 is live and friendbot answers.
# Local only: nothing here touches testnet or mainnet. Stop it with devnet/down.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

docker ps -a --format '{{.Names}}' | grep -qx "$IMPL_NAME" && die "container $IMPL_NAME exists; run devnet/down.sh first"
start=$SECONDS
# The pinned image starts at protocol 28 unless told otherwise (C-HB-071).
docker run -d --name "$IMPL_NAME" -p "127.0.0.1:$IMPL_PORT:8000" "$IMPL_IMAGE" \
  --local --protocol-version 29 --limits testnet --enable core,rpc >/dev/null
log "started $IMPL_NAME from $IMPL_IMAGE"
wait_until 600 "RPC healthy" rpc_healthy || { docker logs --tail 30 "$IMPL_NAME"; die "RPC never became healthy"; }
wait_until 300 "protocol 29" at_protocol 29 || die "the network never reached protocol 29"
wait_until 300 "friendbot answering" friendbot_up || die "friendbot never came up"
log "up: $IMPL_URL/rpc, usable $((SECONDS - start))s after docker run"
