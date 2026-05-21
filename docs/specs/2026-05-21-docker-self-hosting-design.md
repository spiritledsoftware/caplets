# Docker self-hosting design

## Goal

Make the HTTP Caplets service easy to self-host from this repository by adding a source-build Docker image and a Docker Compose setup that preserves server-owned Caplets state.

## Scope

- Add a root `Dockerfile` that builds the monorepo with the pinned pnpm version and runs the built `caplets` CLI.
- Add a root `docker-compose.yml` for local and self-hosted deployments.
- Document Docker usage in the README.
- Keep runtime configuration aligned with the unified Caplets environment variables: `CAPLETS_MODE`, `CAPLETS_SERVER_URL`, `CAPLETS_SERVER_USER`, and `CAPLETS_SERVER_PASSWORD`.

## Non-goals

- Do not publish or maintain a separate registry image in this change.
- Do not add a second npm-install-only Dockerfile.
- Do not change HTTP server behavior or remote control semantics.

## Dockerfile design

Use a multi-stage Node image:

1. Build stage
   - Start from an official Node image that satisfies `node >=22`.
   - Enable Corepack and activate `pnpm@11.0.9`.
   - Copy workspace manifests first for cache-friendly dependency installation.
   - Run `pnpm install --frozen-lockfile`.
   - Copy the full repository.
   - Run `pnpm build`.

2. Runtime stage
   - Start from a smaller official Node runtime image.
   - Enable Corepack and activate `pnpm@11.0.9` so workspace-linked runtime execution is predictable.
   - Copy only the files needed to run the built CLI and its workspace dependencies.
   - Set a durable Caplets home/config location under `/data`.
   - Expose port `5387`.
   - Default command: `caplets serve --transport http --host 0.0.0.0`.

The image represents the checked-out source tree, which is better for this repo than installing the latest published `caplets` package from npm.

## Compose design

Add a single `caplets` service that builds from `.` and runs the Dockerfile.

External network binding should be configurable:

```yaml
ports:
  - "${CAPLETS_BIND_ADDRESS:-127.0.0.1}:${CAPLETS_PORT:-5387}:5387"
```

This gives safe local-only exposure by default while allowing self-hosters to set `CAPLETS_BIND_ADDRESS=0.0.0.0` for LAN or reverse-proxy deployments.

Environment variables:

- `CAPLETS_SERVER_URL` defaults to `http://127.0.0.1:5387` for local use.
- `CAPLETS_SERVER_USER` and `CAPLETS_SERVER_PASSWORD` are passed through for Basic Auth.
- Compose should not hard-code secrets.

Persistence:

- Default: Docker named volume mounted at `/data`.
- Document alternative: replace the named volume with `./data:/data` for a host-visible bind mount.

Health check:

- Use the service health endpoint (`/healthz` for the default base path).
- Keep the health check unauthenticated, matching the HTTP service design.

## Documentation design

Add a README section covering:

- Building and starting with `docker compose up --build`.
- Local URL and health endpoint.
- Setting `CAPLETS_SERVER_PASSWORD` and optional `CAPLETS_SERVER_USER`.
- Changing `CAPLETS_BIND_ADDRESS` for LAN/reverse proxy exposure.
- Named volume default and bind-mount alternative.
- Connecting clients with `CAPLETS_MODE=remote` and `CAPLETS_SERVER_URL`.

## Security considerations

- Default host binding should remain loopback-only.
- LAN/public exposure should require an explicit bind-address change and should strongly recommend `CAPLETS_SERVER_PASSWORD`.
- Remote downstream auth and Caplets state remain server-owned inside the mounted `/data` location.
- Remote control Basic Auth is separate from downstream provider credentials.

## Testing and verification

- `docker compose config` validates the Compose file.
- `docker build .` validates the Dockerfile.
- If Docker can run containers locally, start Compose and verify `GET /healthz` returns success.
- Run relevant repo checks after editing, at minimum formatting and type/build checks affected by docs/config changes.
