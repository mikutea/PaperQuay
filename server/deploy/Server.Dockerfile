# Base manifests verified against the official registries; update through review.
# Base image build-argument overrides are deliberately not exposed.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS dependencies
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG PAPERQUAY_REVISION
LABEL org.opencontainers.image.source="https://github.com/mikutea/PaperQuay" \
      org.opencontainers.image.revision="${PAPERQUAY_REVISION}"
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=dependencies --chown=node:node /app/server/node_modules ./node_modules
COPY --chown=node:node server/package.json ./
COPY --chown=node:node server/src ./src
COPY --chown=node:node server/scripts ./scripts
COPY --chown=node:node server/migrations ./migrations
COPY --chown=node:node server/deploy/runtime-role.sql ./deploy/runtime-role.sql
COPY --chown=node:node packages /app/packages
COPY LICENSE /app/LICENSE
USER node
EXPOSE 4311
CMD ["node", "src/main.ts"]
