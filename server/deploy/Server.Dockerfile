ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE}
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
COPY --chown=node:node server/deploy/runtime-role.sql server/deploy/erasure-role.sql ./deploy/
COPY --chown=node:node packages /app/packages
COPY LICENSE /app/LICENSE
USER node
EXPOSE 4311
CMD ["node", "src/main.ts"]
