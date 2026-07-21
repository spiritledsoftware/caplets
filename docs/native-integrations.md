# Native Integrations And Project Binding

Native integrations use the same Project Binding vocabulary as the CLI.

In local mode, Project Binding is execution context only. Project-bound CLI actions and stdio MCP servers run with the native session's bound project root as their default `cwd`; no Mutagen sync is started because execution stays local. Project-bound stdio MCP processes are scoped by binding fingerprint so one session's process is not reused for a different project root.

Explicit remote mode is eager. If a user configures a Current Host Origin and the remote Project
Binding path cannot start outside stacked serve, the integration fails hard so the caller sees the
configuration problem. Auto mode may start local Caplets first and report a generic remote failure
through `caplets doctor` without selecting a product-specific mode.

## Remote Selection

OpenCode and Pi use the same resolver as `caplets attach`.

- `CAPLETS_MODE=local` exposes local/user/project Caplets in-process only.
- `CAPLETS_MODE=daemon` requires a loopback Current Host Origin from explicit config,
  `CAPLETS_DAEMON_URL`, or setup-written native defaults, and connects without Remote Profile
  credentials.
- `CAPLETS_MODE=remote` requires `CAPLETS_REMOTE_URL` and a saved generic Remote Profile.
- `CAPLETS_MODE=auto` selects generic remote behavior when a remote URL is present, otherwise a
  setup-written daemon when available, and local mode as the final default.

`caplets setup opencode` and `caplets setup pi` write a non-secret native defaults file with the local daemon URL after the daemon is healthy. Explicit integration config wins first, Pi settings win next, runtime environment selectors such as `CAPLETS_MODE`, `CAPLETS_DAEMON_URL`, and `CAPLETS_REMOTE_URL` override setup-written native defaults, and malformed defaults are ignored with a warning.

`CAPLETS_DAEMON_URL` and `CAPLETS_REMOTE_URL` are origins such as
`http://127.0.0.1:5387` or `https://host.example`. Non-root paths, queries, fragments, and embedded
credentials are rejected rather than trimmed or treated as protocol endpoints.

Generic remote mode uses Project Binding for the current project when the Current Host supports it.
A stacked HTTP runtime started with
`caplets serve --transport http --upstream-url <origin>` also attempts upstream Project Binding for
each attach or native session that supplies a project root. Upstream file propagation uses Mutagen
after sync filters and size limits are translated into an enforceable policy. If the upstream
binding path is unavailable or quarantined, local project Caplets and non-project upstream Caplets
remain available and the diagnostic points to `caplets doctor`.

`caplets attach`, native daemon mode, and native remote integrations connect to
`/api/v1/attach/*` for the Caplets runtime surface. `caplets attach <origin>` is stdio-only; HTTP
serving belongs to `caplets serve`. Ordinary MCP clients use exact `/mcp`, governed by configured
exposure policy.

Native metadata should expose:

- selected local, daemon, or generic remote mode and redacted Remote Profile identity
- Binding Session state
- Project Binding endpoint
- last recovery command
