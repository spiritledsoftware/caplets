# Native Integrations And Project Binding

Native integrations use the same Project Binding vocabulary as the CLI.

In local mode, Project Binding is execution context only. Project-bound CLI actions and stdio MCP servers run with the native session's bound project root as their default `cwd`; no Mutagen sync is started because execution stays local. Project-bound stdio MCP processes are scoped by binding fingerprint so one session's process is not reused for a different project root.

Explicit remote mode is eager. If a user configures a remote service and the remote Project Binding path cannot start outside stacked serve, the integration fails hard so the caller sees the configuration problem.

Auto or configured hosted behavior is lazy. The native integration can start local Caplets immediately, then attach hosted Project Binding metadata when the remote side becomes available. When the lazy path fails, local Caplets remain available and the warning points to `caplets doctor`.

## Remote Selection

OpenCode and Pi use the same resolver as `caplets attach`.

- `CAPLETS_MODE=local` exposes local/user/project Caplets in-process only.
- `CAPLETS_MODE=daemon` requires a loopback daemon URL from explicit config, `CAPLETS_DAEMON_URL`, or setup-written native defaults, and connects without Remote Profile credentials.
- `CAPLETS_MODE=remote` requires `CAPLETS_REMOTE_URL` and connects to a self-hosted Caplets service.
- `CAPLETS_MODE=cloud` requires `CAPLETS_REMOTE_URL` pointing at Caplets Cloud and uses the saved Remote Profile from `caplets remote login <cloud-url>`.
- `CAPLETS_MODE=auto` treats Cloud URLs as Cloud, non-Cloud remote URLs as self-hosted, setup-written daemon defaults as daemon mode, and no remote URL/default as local.

`caplets setup opencode` and `caplets setup pi` write a non-secret native defaults file with the local daemon URL after the daemon is healthy. Explicit integration config wins over Pi settings, Pi settings win over native defaults, and malformed defaults are ignored with a warning.

Cloud mode starts Project Binding automatically for the current project and overlays local/project Caplets over the remote workspace. A stacked HTTP runtime started with `caplets serve --transport http --upstream-url <url>` also attempts upstream Project Binding for each attach or native session that supplies a project root. Upstream file propagation uses Mutagen after sync filters and size limits are translated into an enforceable policy. If the upstream binding path is unavailable or quarantined, local project Caplets and non-project upstream Caplets remain available and the diagnostic points to `caplets doctor`.

`caplets attach`, native daemon mode, and native remote integrations connect to the `/v1/attach` API for the Caplets runtime surface. `caplets attach <url>` is stdio-only; HTTP serving belongs to `caplets serve`. Ordinary MCP clients continue to use `/v1/mcp`, which remains governed by configured exposure policy.

Native metadata should expose:

- auth mode: `hosted_cloud`, `self_hosted_remote`, or `unconfigured`
- Selected Workspace ID or slug when hosted Cloud Auth is active
- Binding Session state
- Project Binding endpoint
- last recovery command
