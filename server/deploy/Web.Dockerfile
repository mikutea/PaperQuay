# Base manifests verified against the official registries; update through review.
# Base image build-argument overrides are deliberately not exposed.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS web
WORKDIR /app/apps/mobile
COPY apps/mobile/package.json apps/mobile/package-lock.json ./
RUN npm ci --ignore-scripts
COPY packages /app/packages
COPY apps/mobile/src ./src
COPY apps/mobile/public ./public
COPY apps/mobile/scripts/native-link-build.ts ./scripts/native-link-build.ts
COPY apps/mobile/tsconfig.json apps/mobile/tsconfig.production.json apps/mobile/vite.config.ts apps/mobile/index.html ./
# Public service defaults are mounted at runtime, never supplied as build args.
RUN node node_modules/typescript/bin/tsc --project tsconfig.production.json && node node_modules/vite/bin/vite.js build

FROM caddy:2-alpine@sha256:ae5e525ca6773b0a4ce579c774cb39b3147e1576084139229517bdbcfe3ed812
ARG PAPERQUAY_REVISION
LABEL org.opencontainers.image.source="https://github.com/mikutea/PaperQuay" \
      org.opencontainers.image.revision="${PAPERQUAY_REVISION}"
COPY --from=web /app/apps/mobile/dist /srv
COPY server/deploy/Caddyfile /etc/caddy/Caddyfile
USER 1000:1000
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
