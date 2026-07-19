# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS pnpm-base

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app

FROM pnpm-base AS build-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json

RUN --mount=type=cache,id=auto-work-pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM build-dependencies AS builder

COPY . .

# Prisma Client 必须针对 Linux 镜像生成；随后同时构建 API、Web 和工作区包。
RUN pnpm db:generate \
  && pnpm build

FROM pnpm-base AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma apps/api/prisma
COPY apps/api/scripts/prisma-cli.mjs apps/api/scripts/prisma-cli.mjs
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json

RUN --mount=type=cache,id=auto-work-pnpm,target=/pnpm/store \
  pnpm install --prod --filter @auto-work/api... --frozen-lockfile \
  && pnpm --filter @auto-work/api prisma:generate

FROM pnpm-base AS runtime

ENV NODE_ENV=production
ENV AUTO_WORK_HOST=0.0.0.0
ENV AUTO_WORK_PORT=3760
ENV AUTO_WORK_DATA_DIR=/app/data
ENV AUTO_WORK_WEB_DIST=/app/apps/web/dist
ENV AUTO_WORK_DATABASE_URL=file:/app/data/auto-work.db
ENV AUTO_WORK_REPOSITORY_ROOT=/repositories
ENV AUTO_WORK_VAULT_BACKEND=sealed
ENV AUTO_WORK_VAULT_KEY_FILE=/app/data/vault-master.key
ENV AUTO_WORK_LOG_LEVEL=info

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir --parents /app/data /repositories \
  && chown --recursive node:node /app /repositories

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=production-dependencies --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY --from=production-dependencies --chown=node:node /app/apps/api/scripts ./apps/api/scripts
COPY --from=production-dependencies --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=production-dependencies --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=production-dependencies --chown=node:node /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=production-dependencies --chown=node:node /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --chown=node:node docker ./docker

RUN chmod 0555 /app/docker/entrypoint.sh

USER node

EXPOSE 3760

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=4 \
  CMD ["node", "/app/docker/healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
