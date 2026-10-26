# Hosted simulation (Hetzner)

One VPS runs the whole demo with docker compose:

- `quickstart`: the local Stellar devnet (`backend-soroban/devnet`'s image and network), with its ledger on a volume. RPC is on `127.0.0.1:8300` for debugging only.
- `simulator`: waits for RPC, runs `pnpm devnet:bootstrap` (idempotent), then `supervise.sh` keeps `pnpm simulate` running. It refuels its lanes through the devnet's friendbot, which is never exposed.
- `web`: Caddy, with automatic HTTPS. It serves the observer at `/` and proxies `/rpc` to the devnet, so browsers can read the chain.

The devnet seed derives every signing key, and RPC is public, so the seed is private (`.env`). The observer is built with only the central bank's address; it finds the contract and the banks from the registry on chain.

## Server

Ubuntu 24.04, 4 vCPU / 8 GB (CX32 or CPX31), firewall inbound TCP 22, 80, 443. Then, as root:

```sh
apt-get update && apt-get -y upgrade
curl -fsSL https://get.docker.com | sh
apt-get -y install unattended-upgrades
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
adduser --disabled-password --gecos '' rtgs && usermod -aG docker rtgs
mkdir -p ~rtgs/.ssh && cp ~/.ssh/authorized_keys ~rtgs/.ssh/ && chown -R rtgs: ~rtgs/.ssh
```

## Deploy

From a checkout (no GitHub access needed on the server):

```sh
git archive HEAD | ssh rtgs@HOST 'mkdir -p ~/stellar-rtgs && tar -x -C ~/stellar-rtgs'
```

First time, on the server in `~/stellar-rtgs/deploy/hetzner`:

```sh
cp .env.example .env
sed -i "s/^RTGS_DEVNET_SEED=.*/RTGS_DEVNET_SEED=$(openssl rand -hex 16)/" .env   # and set SITE_HOST
docker compose up -d --build quickstart simulator
docker compose logs -f simulator      # the bootstrap prints the deployment JSON, then the simulation starts
```

Copy the deployment's `centralBank` into `.env` as `RTGS_DEVNET_CENTRAL_BANK`, then start the observer:

```sh
docker compose up -d --build web
```

The observer is at `https://SITE_HOST/`. Later updates: ship the code again, then `docker compose up -d --build`.

## Operating it

- Logs: `docker compose logs -f simulator`. A summary every 30 s, including the XLM burn and refuels.
- Stop: `docker compose stop simulator`. The simulation drains and publishes `stopped`, and the observer shows it as paused.
- The simulator process recycles every 12 h (`--duration 43200`); the supervisor starts it again.
- Reset the ledger: `docker compose down -v && docker compose up -d`. The bootstrap deploys a new contract; the central bank's address stays the same, so the observer needs no rebuild.
- Don't run the central-bank app's auto-keeper against this devnet: both sign as the central bank, and collide on its sequence number.
- RPC keeps about 7 days of events, so the observer's history starts at most a week back.
