# Native Integrations And Project Binding

Native integrations use the same Project Binding vocabulary as the CLI.

Explicit remote mode is eager. If a user configures a remote service and the remote Project Binding path cannot start outside stacked serve, the integration fails hard so the caller sees the configuration problem.

Auto or configured hosted behavior is lazy. The native integration can start local Caplets immediately, then attach hosted Project Binding metadata when the remote side becomes available. When the lazy path fails, local Caplets remain available and the warning points to `caplets doctor`.

## Remote Selection

OpenCode and Pi use the same resolver as `caplets attach`.

- `CAPLETS_MODE=local` exposes local/user/project Caplets only.
- `CAPLETS_MODE=remote` requires `CAPLETS_REMOTE_URL` and connects to a self-hosted Caplets service.
- `CAPLETS_MODE=cloud` requires `CAPLETS_REMOTE_URL` pointing at Caplets Cloud and uses the saved Remote Profile from `caplets remote login <cloud-url>`.
- `CAPLETS_MODE=auto` treats Cloud URLs as Cloud, non-Cloud remote URLs as self-hosted, and no remote URL as local.

Cloud mode starts Project Binding automatically for the current project and overlays local/project Caplets over the remote workspace. A stacked HTTP runtime started with `caplets serve --transport http --upstream-url <url>` also attempts upstream Project Binding for each attach or native session that supplies a project root. If the upstream binding path is unavailable, local project Caplets and non-project upstream Caplets remain available and the diagnostic points to `caplets doctor`.

`caplets attach` and native remote integrations connect to the remote `/v1/attach` API for the Caplets runtime surface. `caplets attach <url>` is stdio-only; HTTP serving belongs to `caplets serve`. Ordinary MCP clients continue to use `/v1/mcp`, which remains governed by configured exposure policy.

Native metadata should expose:

- auth mode: `hosted_cloud`, `self_hosted_remote`, or `unconfigured`
- Selected Workspace ID or slug when hosted Cloud Auth is active
- Binding Session state
- Project Binding endpoint
- last recovery command
