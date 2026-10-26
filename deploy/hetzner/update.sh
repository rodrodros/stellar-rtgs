#!/usr/bin/env bash
# Updates the hosted simulation to the latest commit of the branch this clone tracks (main):
# pulls from GitHub, then rebuilds and restarts whatever changed. .env and the volumes stay.
# The testnet deployment (compose.testnet.yml) is updated too when .env.testnet exists.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

git pull --ff-only
git log -1 --format='deploying %h %s'
# No build attestations: one is new on every build, so an unchanged image would get a new id and
# `up --build` would restart its service. (Compose's `provenance: false` doesn't stop it.) These
# images never leave the server.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
docker compose up -d --build
testnet=(docker compose -f compose.testnet.yml --env-file .env.testnet)
if [[ -f .env.testnet ]]; then "${testnet[@]}" up -d --build; fi
docker image prune -f >/dev/null
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
if [[ -f .env.testnet ]]; then "${testnet[@]}" ps --format 'table {{.Service}}\t{{.Status}}'; fi
