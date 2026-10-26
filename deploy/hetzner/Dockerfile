# Built from compose.yml: the context is frontend-web/, and `deploy` names this directory.

FROM node:26-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# The simulator, run from source: bootstrap the devnet, then supervise.sh keeps it running.
FROM deps AS simulator
COPY --from=deploy --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# The three apps, built against the public RPC and served from one site: the observer at /,
# the others under their own paths, which the observer links to. VITE_* values are baked in at
# build time. The seed is among them, as locally: the central-bank and participant apps derive
# their devnet keys from it in the browser.
FROM deps AS apps-build
ARG VITE_RTGS_DEVNET_RPC_URL
ARG VITE_RTGS_DEVNET_CENTRAL_BANK
ARG VITE_RTGS_DEVNET_SEED
ENV VITE_RTGS_CENTRAL_BANK_APP_URL=/central-bank/ VITE_RTGS_PARTICIPANT_APP_URL=/participant/
RUN test -n "$VITE_RTGS_DEVNET_RPC_URL" && test -n "$VITE_RTGS_DEVNET_CENTRAL_BANK" && test -n "$VITE_RTGS_DEVNET_SEED" \
  && pnpm --filter @rtgs/observer build \
  && pnpm --filter @rtgs/central-bank build --base=/central-bank/ \
  && pnpm --filter @rtgs/participant build --base=/participant/

FROM caddy:2 AS web
COPY --from=deploy Caddyfile /etc/caddy/Caddyfile
COPY --from=deploy llms.txt /usr/share/rtgs/llms.txt
COPY --from=apps-build /app/apps/observer/dist /srv
COPY --from=apps-build /app/apps/central-bank/dist /srv/central-bank
COPY --from=apps-build /app/apps/participant/dist /srv/participant
