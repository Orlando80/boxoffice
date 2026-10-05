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
RUN pnpm install --frozen-lockfile --filter=boxoffice  && pnpm exec turbo prune @boxoffice/api --docker

FROM base AS installer
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .

# Runs TypeScript source with tsx, exactly as locally (no compile step exists).
FROM node:${NODE_VERSION}-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /repo
COPY --from=installer --chown=node:node /repo ./
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node_modules/.bin/tsx", "src/index.ts"]
