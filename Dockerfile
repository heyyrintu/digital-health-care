# syntax=docker/dockerfile:1
# One lockfile and Linux build for the web, API, workers and migration tooling.
FROM node:22-bookworm-slim AS dependencies
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=dhc-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter @dhc/api... --filter @dhc/workers... --filter @dhc/web...
RUN pnpm --filter @dhc/db generate

FROM dependencies AS backend-build
RUN pnpm --filter @dhc/api build && pnpm --filter @dhc/workers build

FROM node:22-bookworm-slim AS backend
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* && corepack enable && corepack prepare pnpm@10.28.0 --activate
# Keep the workspace dependency graph, Prisma CLI/migrations and PDF/font assets intact.
# The build context explicitly excludes local env files, credentials and generated output.
WORKDIR /app
COPY --from=backend-build --chown=node:node /app /app
RUN mkdir -p /data/files && chown node:node /data/files
USER node
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]

FROM dependencies AS web-build
RUN pnpm --filter @dhc/web build && mkdir -p apps/web/public

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM nginx:stable-alpine AS gateway
COPY deploy/coolify/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
