# Caplets CLI Inspection Polish

## Summary

Add a small read-only inspection suite to the existing Commander-based CLI:

- `caplets --version` prints the package version from `package.json`.
- `caplets list` lists enabled configured Caplets by default.
- `caplets list --all` includes disabled entries.
- `caplets list --json` emits stable machine-readable JSON.
- `caplets config path` prints the effective user config path, honoring `CAPLETS_CONFIG`.
- `caplets config paths` prints user config, project config, Caplets roots, auth directory, and trust/env state.

No runtime MCP server behavior changes.

## Key Changes

- Update `src/cli.ts` to import `package.json` version and register Commander version support.
- Add a `list` command that loads config through existing `loadConfig(envConfigPath())`, builds a `ServerRegistry`, and prints:
  - text columns: `server`, `backend`, `status`, `name`
  - JSON array objects: `{ server, backend, name, description, disabled, status }`
- Add `config` subcommands:
  - `config path`: prints only `resolveConfigPath(envConfigPath())`
  - `config paths`: prints resolved user config path, project config path, user root, project root, auth dir, whether `CAPLETS_CONFIG` is set, and whether `CAPLETS_TRUST_PROJECT_CAPLETS` is enabled
  - `--json` on `config paths` for scriptable output
- Keep existing `init` and `auth` behavior unchanged.
- Keep disabled Caplets excluded from `caplets list` unless `--all` is passed.

## Interfaces

Public CLI additions:

```sh
caplets --version
caplets list
caplets list --all
caplets list --json
caplets config path
caplets config paths
caplets config paths --json
```

Recommended text output shapes:

```txt
server  backend  status       name
docs    mcp      not_started  Hosted Docs
users   openapi  not_started  Users API
```

```txt
userConfig: /home/you/.caplets/config.json
projectConfig: /repo/.caplets/config.json
userRoot: /home/you/.caplets
projectRoot: /repo/.caplets
authDir: /home/you/.caplets/auth
envConfig: unset
projectCapletsTrusted: false
```

## Test Plan

Add focused tests in `test/cli.test.ts`:

- `runCli(["--version"])` prints `package.json` version and does not throw.
- `runCli(["list"])` prints only enabled MCP/OpenAPI/GraphQL Caplets.
- `runCli(["list", "--all"])` includes disabled Caplets with `disabled` status.
- `runCli(["list", "--json"])` emits parseable JSON and redacts/no-ops on auth secrets.
- `runCli(["config", "path"])` honors `CAPLETS_CONFIG`.
- `runCli(["config", "paths", "--json"])` returns stable resolved paths and env/trust flags.
- Unsupported options still raise `REQUEST_INVALID`.

Run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Assumptions

- "Servers" means all configured Caplet backends: MCP servers, OpenAPI endpoints, and GraphQL endpoints.
- Human-readable text is the default; `--json` is the stable automation contract.
- The inspection commands must be read-only and must not start downstream servers, load remote specs, or validate live OAuth.
- `caplets serve` remains handled by `src/index.ts` as the MCP server entrypoint.
