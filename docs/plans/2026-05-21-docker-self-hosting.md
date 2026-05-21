# Docker Self-Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add source-build Docker and Docker Compose support so Caplets can be self-hosted as an HTTP service with persistent server-owned state.

**Architecture:** The implementation adds root container artifacts only: a multi-stage `Dockerfile`, a focused `.dockerignore`, and a `docker-compose.yml` service that runs `caplets serve --transport http`. Runtime state is persisted under `/data` via XDG environment variables, while Compose owns external bind address/port configuration and passes through unified `CAPLETS_SERVER_*` settings.

**Tech Stack:** Docker, Docker Compose, Node.js 24 slim images, Corepack, `pnpm@11.0.9`, Caplets CLI HTTP serve mode.

---

## File Structure

- Create: `.dockerignore`
  - Keeps Docker build contexts small and prevents local caches, VCS metadata, generated output, and secret-bearing local state from entering the image build context.
- Create: `Dockerfile`
  - Multi-stage source-build image for the monorepo.
  - Build stage installs workspace dependencies and runs `pnpm build`.
  - Runtime stage copies the built workspace and starts the HTTP Caplets server.
- Create: `docker-compose.yml`
  - Local/self-hosted Compose service with configurable host binding, port, credentials, health check, and durable named volume.
- Modify: `README.md`
  - Adds a Docker Compose self-hosting section near the existing “Remote Caplets service” docs.
- Existing reference only: `docs/specs/2026-05-21-docker-self-hosting-design.md`
  - Source of truth for the approved design.

---

### Task 1: Add Docker build context rules

**Files:**

- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

Create `.dockerignore` with exactly this content:

```dockerignore
.git
.github
.husky
.brv
.pi
.pi-lens
.opencode
.claude-plugin
node_modules
**/node_modules
dist
**/dist
.turbo
coverage
*.log
.env
.env.*
!.env.example
.caplets
**/.caplets
.DS_Store
```

Rationale:

- `node_modules`, `dist`, `.turbo`, and `coverage` are regenerated inside Docker.
- `.git`, agent state directories, and local Caplets config/state should not enter the image context.
- `.env` files are excluded to avoid accidental secret inclusion.

- [ ] **Step 2: Verify `.dockerignore` exists and is formatted as plain text**

Run:

```bash
test -f .dockerignore && sed -n '1,120p' .dockerignore
```

Expected output contains the entries from Step 1 and exits with status `0`.

- [ ] **Step 3: Commit Docker ignore rules**

Run:

```bash
git add .dockerignore
git commit -m "build: add docker ignore rules"
```

Expected: commit succeeds and includes only `.dockerignore`.

---

### Task 2: Add the source-build Dockerfile

**Files:**

- Create: `Dockerfile`

- [ ] **Step 1: Create `Dockerfile`**

Create `Dockerfile` with exactly this content:

```dockerfile
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

CMD ["pnpm", "--filter", "caplets", "exec", "caplets", "serve", "--transport", "http", "--host", "0.0.0.0"]
```

Notes for implementer:

- Keep `CAPLETS_SERVER_URL` as a default only. Compose will override it for user-facing deployments.
- `XDG_CONFIG_HOME=/data/config` makes the default config path `/data/config/caplets/config.json`.
- `XDG_STATE_HOME=/data/state` makes auth state persist under `/data/state/caplets/auth`.
- The runtime image intentionally copies the built workspace and `node_modules` from the build stage to preserve workspace links for local-source execution.

- [ ] **Step 2: Validate Dockerfile parses with Docker**

Run:

```bash
docker build --target runtime -t caplets:self-host-test .
```

Expected: build succeeds. The final lines should include an image tagged `caplets:self-host-test`.

If Docker is unavailable in the execution environment, record the exact Docker error in the task notes and continue to Step 3; do not claim the Docker build was verified.

- [ ] **Step 3: Commit the Dockerfile**

Run:

```bash
git add Dockerfile
git commit -m "build: add caplets docker image"
```

Expected: commit succeeds and includes only `Dockerfile`.

---

### Task 3: Add Docker Compose service

**Files:**

- Create: `docker-compose.yml`

- [ ] **Step 1: Create `docker-compose.yml`**

Create `docker-compose.yml` with exactly this content:

```yaml
services:
  caplets:
    build:
      context: .
      dockerfile: Dockerfile
    image: caplets:local
    restart: unless-stopped
    environment:
      CAPLETS_SERVER_URL: ${CAPLETS_SERVER_URL:-http://127.0.0.1:5387}
      CAPLETS_SERVER_USER: ${CAPLETS_SERVER_USER:-caplets}
      CAPLETS_SERVER_PASSWORD: ${CAPLETS_SERVER_PASSWORD:-}
      XDG_CONFIG_HOME: /data/config
      XDG_STATE_HOME: /data/state
    ports:
      - "${CAPLETS_BIND_ADDRESS:-127.0.0.1}:${CAPLETS_PORT:-5387}:5387"
    volumes:
      - caplets-data:/data
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          node -e "fetch('http://127.0.0.1:5387/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 10s

volumes:
  caplets-data:
```

Rationale:

- The container listens internally on `0.0.0.0:5387` from the Dockerfile command.
- Compose defaults external binding to `127.0.0.1` for safety.
- `CAPLETS_SERVER_PASSWORD` is intentionally empty by default so local loopback startup works without hard-coded secrets.
- Self-hosters exposing beyond loopback must set `CAPLETS_SERVER_PASSWORD` and should place the service behind HTTPS/TLS.

- [ ] **Step 2: Validate Compose renders correctly**

Run:

```bash
docker compose config
```

Expected: command exits `0` and rendered output includes:

```yaml
ports:
  - mode: ingress
    host_ip: 127.0.0.1
    target: 5387
    published: "5387"
```

Compose output formatting can vary by Docker Compose version. If the exact YAML differs, verify these equivalent facts in the rendered output:

- service name is `caplets`
- published port is `5387`
- host IP is `127.0.0.1`
- named volume `caplets-data` is declared

- [ ] **Step 3: Validate LAN binding override renders correctly**

Run:

```bash
CAPLETS_BIND_ADDRESS=0.0.0.0 CAPLETS_PORT=15387 docker compose config
```

Expected: command exits `0` and rendered output shows host IP `0.0.0.0` and published port `15387` for target port `5387`.

- [ ] **Step 4: Commit Compose service**

Run:

```bash
git add docker-compose.yml
git commit -m "build: add docker compose service"
```

Expected: commit succeeds and includes only `docker-compose.yml`.

---

### Task 4: Document Docker self-hosting

**Files:**

- Modify: `README.md` after the remote HTTP service paragraph and before “Native integrations and remote-capable CLI commands read remote client settings from environment variables:”

- [ ] **Step 1: Insert Docker Compose documentation**

In `README.md`, find this paragraph under `### Remote Caplets service`:

```markdown
`caplets serve --transport http` serves plain HTTP. For non-loopback or network access, expose it only through HTTPS/TLS (for example, a reverse proxy or secure tunnel) and enable Basic Auth; Basic Auth over plain HTTP exposes credentials. Keep credentials out of plugin manifests.
```

Immediately after it, insert this section:

````markdown
#### Docker Compose self-hosting

This repository includes a source-build Docker image and Compose service for running the HTTP service from the checked-out source tree:

```sh
CAPLETS_SERVER_PASSWORD=change-me docker compose up --build
```

By default, Compose publishes the service on loopback only:

- Base URL: `http://127.0.0.1:5387`
- MCP endpoint: `http://127.0.0.1:5387/mcp`
- Control endpoint: `http://127.0.0.1:5387/control`
- Health endpoint: `http://127.0.0.1:5387/healthz`

The service stores Caplets config and auth state in a Docker named volume mounted at `/data`. To use a host-visible bind mount instead, replace this Compose volume entry:

```yaml
volumes:
  - caplets-data:/data
```

with:

```yaml
volumes:
  - ./data:/data
```

To expose the service to a LAN interface or reverse proxy, set an explicit bind address and public base URL:

```sh
CAPLETS_BIND_ADDRESS=0.0.0.0 \
CAPLETS_SERVER_URL=https://caplets.example.com \
CAPLETS_SERVER_PASSWORD=change-me \
docker compose up --build
```

Only expose Caplets beyond loopback through HTTPS/TLS and Basic Auth. `CAPLETS_SERVER_PASSWORD` protects both the MCP and control endpoints; downstream provider tokens and auth files remain server-owned inside the mounted `/data` location.
````

Important markdown escaping note: the inserted section contains fenced code blocks inside markdown. Keep each fence exactly as shown.

- [ ] **Step 2: Verify README formatting**

Run:

```bash
pnpm format:check README.md
```

Expected: `All matched files use the correct format.`

- [ ] **Step 3: Commit README documentation**

Run:

```bash
git add README.md
git commit -m "docs: document docker self-hosting"
```

Expected: commit succeeds and includes only `README.md`.

---

### Task 5: Run final verification

**Files:**

- Verify: `.dockerignore`
- Verify: `Dockerfile`
- Verify: `docker-compose.yml`
- Verify: `README.md`

- [ ] **Step 1: Run formatting check for changed text files**

Run:

```bash
pnpm format:check .dockerignore Dockerfile docker-compose.yml README.md docs/specs/2026-05-21-docker-self-hosting-design.md
```

Expected: command exits `0` and reports all matched files use correct format.

- [ ] **Step 2: Run Compose config validation**

Run:

```bash
docker compose config
```

Expected: command exits `0` and renders the `caplets` service and `caplets-data` volume.

If Docker Compose is unavailable, record the exact command failure in the task notes and continue; do not claim Compose was verified.

- [ ] **Step 3: Run Docker image build verification**

Run:

```bash
docker build -t caplets:self-host-test .
```

Expected: command exits `0` and creates image `caplets:self-host-test`.

If Docker is unavailable, record the exact command failure in the task notes and continue; do not claim the image build was verified.

- [ ] **Step 4: Optionally run service smoke test when Docker daemon is available**

Run:

```bash
CAPLETS_SERVER_PASSWORD=change-me docker compose up --build -d
sleep 5
curl --fail http://127.0.0.1:5387/healthz
docker compose down
```

Expected:

- `curl` exits `0`.
- Response body is JSON with a healthy Caplets HTTP service, including `transport` set to `http`.
- `docker compose down` exits `0` and stops the service.

If the service fails to become healthy, inspect logs with:

```bash
docker compose logs caplets
```

Fix the issue before completing the task.

- [ ] **Step 5: Run repo-level non-Docker checks**

Run:

```bash
pnpm verify
```

Expected: command exits `0`.

- [ ] **Step 6: Commit any verification fixes**

If Steps 1-5 required fixes, commit those fixes:

```bash
git add .dockerignore Dockerfile docker-compose.yml README.md
git commit -m "fix: polish docker self-hosting setup"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review

### Spec coverage

- Root `Dockerfile`: Task 2.
- Root `docker-compose.yml`: Task 3.
- README Docker usage docs: Task 4.
- Unified env alignment: Task 2 and Task 3 use `CAPLETS_SERVER_URL`, `CAPLETS_SERVER_USER`, `CAPLETS_SERVER_PASSWORD`, and XDG state/config paths; Task 4 documents remote clients with the same server URL model.
- Source-build image rather than npm-install-only image: Task 2.
- Configurable external binding: Task 3 and Task 4.
- Named volume default and bind-mount alternative: Task 3 and Task 4.
- Health check: Task 3 and Task 5.
- Security guidance for loopback defaults, HTTPS/TLS, Basic Auth, and server-owned state: Task 3 and Task 4.
- Verification commands: Task 2, Task 3, and Task 5.

### Placeholder scan

No placeholder markers are present. Every file creation step includes exact content. Every verification step includes exact commands and expected outcomes.

### Type and name consistency

- Compose service name is consistently `caplets`.
- Named volume is consistently `caplets-data`.
- Internal port is consistently `5387`.
- External bind variables are consistently `CAPLETS_BIND_ADDRESS` and `CAPLETS_PORT`.
- Unified server variables are consistently `CAPLETS_SERVER_URL`, `CAPLETS_SERVER_USER`, and `CAPLETS_SERVER_PASSWORD`.
