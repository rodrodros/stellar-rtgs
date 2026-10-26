#!/usr/bin/env bash
# Updates the hosted simulation to the latest commit of the branch this clone tracks (main):
# pulls from GitHub, then rebuilds and restarts whatever changed. .env and the volumes stay.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

git pull --ff-only
git log -1 --format='deploying %h %s'
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
