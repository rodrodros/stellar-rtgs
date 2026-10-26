# Hosted simulation (Hetzner)

One VPS runs the whole demo with docker compose:

- `quickstart`: the local Stellar devnet (`backend-soroban/devnet`'s image and network), with its ledger on a volume. RPC is on `127.0.0.1:8300` for debugging only.
- `simulator`: waits for RPC, runs `pnpm devnet:bootstrap` (idempotent), then `supervise.sh` keeps `pnpm simulate` running. It refuels its lanes through the devnet's friendbot, which is never exposed.
- `web`: Caddy, with automatic HTTPS. It serves the observer at `/`, the central bank's app at `/central-bank/` and the participants' app at `/participant/` (the observer links both), and proxies `/rpc` to the devnet, so browsers can read the chain. `/llms.txt` tells LLMs, which only see the SPAs' empty shells, what the site is and how to read the chain; Caddy fills in the host and central bank from `.env`.

The devnet seed derives every signing key. As locally, the central-bank and participant apps are built with it and sign in the browser, so anyone who opens them can act as the central bank or a bank, and change the running simulation. Don't use the central-bank app's auto-keeper here (see below).

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

The server runs a clone of https://github.com/rodrodros/stellar-rtgs on `main`. What's pushed there is what gets deployed.

First time, as `rtgs` on the server:

```sh
git clone https://github.com/rodrodros/stellar-rtgs.git ~/stellar-rtgs
cd ~/stellar-rtgs/deploy/hetzner
cp .env.example .env
sed -i "s/^RTGS_DEVNET_SEED=.*/RTGS_DEVNET_SEED=$(openssl rand -hex 16)/" .env   # and set SITE_HOST
docker compose up -d --build quickstart simulator
docker compose logs -f simulator      # the bootstrap prints the deployment JSON, then the simulation starts
```

Copy the deployment's `centralBank` into `.env` as `RTGS_DEVNET_CENTRAL_BANK`, then start the apps:

```sh
docker compose up -d --build web
```

The observer is at `https://SITE_HOST/`, the other apps at `/central-bank/` and `/participant/`.

## Update

Push to `main`, then on the server:

```sh
~/stellar-rtgs/deploy/hetzner/update.sh
```

It pulls, rebuilds the images, and restarts what changed: the simulator stops gracefully and starts again, the observer is rebuilt with the same `.env`. The ledger stays.

## Operating it

- Logs: `docker compose logs -f simulator`. A summary every 30 s, including the XLM burn and refuels.
- Stop: `docker compose stop simulator`. The simulation drains and publishes `stopped`, and the observer shows it as paused.
- The simulator process recycles every 12 h (`--duration 43200`); the supervisor starts it again.
- Reset the ledger: `docker compose down -v && docker compose up -d`. The bootstrap deploys a new contract; the central bank's address stays the same, so the observer needs no rebuild.
- Don't run the central-bank app's auto-keeper against this devnet: both sign as the central bank, and collide on its sequence number.
- RPC keeps about 7 days of events, so the observer's history starts at most a week back.

## Testnet

The same simulation also runs on the public Stellar testnet, next to the devnet on the same server, as a second compose project (`compose.testnet.yml`, project `rtgs-testnet`):

- `simulator`: the same image with `RTGS_NETWORK=testnet`. It bootstraps against SDF's public RPC and friendbot, then runs the simulation more slowly (`--rate 0.3`), because testnet ledgers close every ~5 s and the RPC is shared.
- `web`: the apps built to open on the testnet, served over plain HTTP on the `rtgs-edge` network. There is no `/rpc`: browsers use the public testnet RPC. The devnet's Caddy holds 80 and 443, terminates TLS for `TESTNET_SITE_HOST` and proxies to it, so `compose.yml` must be up first.

The testnet seed works like the devnet's: the apps are built with it, and anyone who opens them can act as the demo identities, with test funds only.

First time, after the devnet is running:

```sh
cd ~/stellar-rtgs/deploy/hetzner
cp .env.testnet.example .env.testnet
sed -i "s/^RTGS_TESTNET_SEED=.*/RTGS_TESTNET_SEED=$(openssl rand -hex 16)/" .env.testnet   # and set TESTNET_SITE_HOST
echo "TESTNET_SITE_HOST=<the same host>" >> .env
docker compose up -d web                # the devnet's Caddy picks up the testnet host
alias tn='docker compose -f compose.testnet.yml --env-file .env.testnet'
tn up -d --build simulator
tn logs -f simulator                    # the bootstrap prints the deployment JSON
```

Copy the deployment's `centralBank` into `.env.testnet` as `RTGS_TESTNET_CENTRAL_BANK`, then start the apps with `tn up -d --build web`. The observer is at `https://TESTNET_SITE_HOST/`. `update.sh` updates the testnet project too once `.env.testnet` exists.

SDF resets the testnet every few months. After a reset, restart the simulator (`tn restart simulator`): the bootstrap funds the accounts again and deploys a new contract. The central bank's address stays the same, so the apps need no rebuild.
