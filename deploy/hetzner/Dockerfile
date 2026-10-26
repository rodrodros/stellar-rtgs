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

# The observer, built against the public RPC. VITE_* values are baked in at build time.
FROM deps AS observer-build
ARG VITE_RTGS_DEVNET_RPC_URL
ARG VITE_RTGS_DEVNET_CENTRAL_BANK
RUN test -n "$VITE_RTGS_DEVNET_RPC_URL" && test -n "$VITE_RTGS_DEVNET_CENTRAL_BANK" \
  && pnpm --filter @rtgs/observer build

FROM caddy:2 AS web
COPY --from=deploy Caddyfile /etc/caddy/Caddyfile
COPY --from=deploy llms.txt /usr/share/rtgs/llms.txt
COPY --from=observer-build /app/apps/observer/dist /srv
