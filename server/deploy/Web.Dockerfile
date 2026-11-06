ARG NODE_IMAGE=node:24-bookworm-slim
ARG CADDY_IMAGE=caddy:2-alpine
FROM ${NODE_IMAGE} AS web
WORKDIR /app/apps/mobile
COPY apps/mobile/package.json apps/mobile/package-lock.json ./
RUN npm ci --ignore-scripts
COPY packages /app/packages
COPY apps/mobile/src ./src
COPY apps/mobile/public ./public
COPY apps/mobile/tsconfig.json apps/mobile/tsconfig.production.json apps/mobile/vite.config.ts apps/mobile/index.html ./
# Public service defaults are mounted at runtime, never supplied as build args.
RUN node node_modules/typescript/bin/tsc --project tsconfig.production.json && node node_modules/vite/bin/vite.js build

FROM ${CADDY_IMAGE}
ARG PAPERQUAY_REVISION
LABEL org.opencontainers.image.source="https://github.com/mikutea/PaperQuay" \
      org.opencontainers.image.revision="${PAPERQUAY_REVISION}"
COPY --from=web /app/apps/mobile/dist /srv
COPY server/deploy/Caddyfile /etc/caddy/Caddyfile
USER 1000:1000
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
