# syntax=docker/dockerfile:1
# No default: a build without --build-arg NODE_VERSION fails loudly (see pnpm docker:build).
ARG NODE_VERSION

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Prune the monorepo to this app and its workspace dependencies.
# Only the root importer (turbo) is installed, at the version the lockfile pins.
FROM base AS pruner
COPY . .
RUN pnpm install --frozen-lockfile --filter=boxoffice  && pnpm exec turbo prune @boxoffice/admin --docker

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm --filter @boxoffice/admin build

FROM node:${NODE_VERSION}-bookworm-slim AS runner
ENV NODE_ENV=production     NEXT_TELEMETRY_DISABLED=1     HOSTNAME=0.0.0.0     PORT=3001
WORKDIR /srv
COPY --from=builder --chown=node:node /repo/apps/admin/.next/standalone/ ./
COPY --from=builder --chown=node:node /repo/apps/admin/.next/static ./apps/admin/.next/static
USER node
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]
