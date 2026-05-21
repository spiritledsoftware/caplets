# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24-bookworm-slim
ARG PNPM_VERSION=11.0.9

FROM node:${NODE_VERSION} AS build
ARG PNPM_VERSION
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json vitest.config.ts ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/opencode/package.json packages/opencode/package.json
COPY packages/pi/package.json packages/pi/package.json
COPY packages/benchmarks/package.json packages/benchmarks/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

FROM node:${NODE_VERSION} AS runtime
ARG PNPM_VERSION
ENV NODE_ENV=production \
    XDG_CONFIG_HOME=/data/config \
    XDG_STATE_HOME=/data/state \
    CAPLETS_SERVER_URL=http://127.0.0.1:5387
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY --from=build /app /app

VOLUME ["/data"]
EXPOSE 5387

CMD ["sh", "-c", "test -f /data/config/caplets/config.json || CAPLETS_MODE=local node packages/cli/dist/index.js init && exec env CAPLETS_MODE=local node packages/cli/dist/index.js serve --transport http --host 0.0.0.0"]
