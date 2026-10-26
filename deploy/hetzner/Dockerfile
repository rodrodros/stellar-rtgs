# Built from compose.yml: the context is frontend-web/, and `deploy` names this directory.

FROM node:26-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# The simulator, run from source: bootstrap the network (RTGS_NETWORK, devnet by default), then
# supervise.sh keeps it running.
FROM deps AS simulator
COPY --from=deploy --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# The three apps, built against the public RPC and served from one site: the observer at /,
# the others under their own paths, which the observer links to. VITE_* values are baked in at
# build time. The seed is among them, as locally: the central-bank and participant apps derive
# their demo keys from it in the browser. RTGS_NETWORK is the deployment's own network; the
# apps open on DEFAULT_NETWORK (RTGS_NETWORK unless set) and can switch to any network they were
# given settings for. On the testnet they use the public testnet RPC unless
# VITE_RTGS_TESTNET_RPC_URL says otherwise.
FROM deps AS apps-build
ARG RTGS_NETWORK=devnet
ARG DEFAULT_NETWORK=$RTGS_NETWORK
ARG VITE_RTGS_DEVNET_RPC_URL
ARG VITE_RTGS_DEVNET_CENTRAL_BANK
ARG VITE_RTGS_DEVNET_SEED
ARG VITE_RTGS_TESTNET_RPC_URL
ARG VITE_RTGS_TESTNET_CENTRAL_BANK
ARG VITE_RTGS_TESTNET_SEED
ENV VITE_RTGS_CENTRAL_BANK_APP_URL=/central-bank/ VITE_RTGS_PARTICIPANT_APP_URL=/participant/ \
  VITE_RTGS_DEFAULT_NETWORK=$DEFAULT_NETWORK
RUN need() { [ -n "$2" ] || { echo "apps-build: $1 is required (RTGS_NETWORK=$RTGS_NETWORK, DEFAULT_NETWORK=$DEFAULT_NETWORK)" >&2; exit 1; }; }; \
  if [ "$RTGS_NETWORK" = testnet ] || [ "$DEFAULT_NETWORK" = testnet ]; then \
    need RTGS_TESTNET_CENTRAL_BANK "$VITE_RTGS_TESTNET_CENTRAL_BANK" && need RTGS_TESTNET_SEED "$VITE_RTGS_TESTNET_SEED"; \
  fi \
  && if [ "$RTGS_NETWORK" != testnet ]; then \
    need RTGS_DEVNET_CENTRAL_BANK "$VITE_RTGS_DEVNET_CENTRAL_BANK" && need RTGS_DEVNET_SEED "$VITE_RTGS_DEVNET_SEED"; \
  fi \
  && pnpm --filter @rtgs/observer build \
  && pnpm --filter @rtgs/central-bank build --base=/central-bank/ \
  && pnpm --filter @rtgs/participant build --base=/participant/

# CADDYFILE and LLMS_TXT pick the devnet's files or the testnet's.
FROM caddy:2 AS web
ARG CADDYFILE=Caddyfile
ARG LLMS_TXT=llms.txt
COPY --from=deploy ${CADDYFILE} /etc/caddy/Caddyfile
COPY --from=deploy ${LLMS_TXT} /usr/share/rtgs/llms.txt
COPY --from=apps-build /app/apps/observer/dist /srv
COPY --from=apps-build /app/apps/central-bank/dist /srv/central-bank
COPY --from=apps-build /app/apps/participant/dist /srv/participant
