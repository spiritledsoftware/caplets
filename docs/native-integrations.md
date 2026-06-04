# Native Integrations And Project Binding

Native integrations use the same Project Binding vocabulary as the CLI.

Explicit remote mode is eager. If a user configures a remote service and the remote Project Binding path cannot start, the integration fails hard so the caller sees the configuration problem.

Auto or configured hosted behavior is lazy. The native integration can start local Caplets immediately, then attach hosted Project Binding metadata when the remote side becomes available. When the lazy path fails, local Caplets remain available and the warning points to `caplets doctor`.

## Remote Selection

OpenCode and Pi use the same resolver as `caplets attach`.

- `CAPLETS_MODE=local` exposes local/user/project Caplets only.
- `CAPLETS_MODE=remote` requires `CAPLETS_REMOTE_URL` and connects to a self-hosted Caplets service.
- `CAPLETS_MODE=cloud` requires `CAPLETS_REMOTE_URL` pointing at Caplets Cloud and uses saved `caplets cloud auth login` credentials.
- `CAPLETS_MODE=auto` treats Cloud URLs as Cloud, non-Cloud remote URLs as self-hosted, and no remote URL as local.

Cloud mode starts Project Binding automatically for the current project and overlays local/project Caplets over the remote workspace.

Native metadata should expose:

- auth mode: `hosted_cloud`, `self_hosted_remote`, or `unconfigured`
- Selected Workspace ID or slug when hosted Cloud Auth is active
- Binding Session state
- Project Binding endpoint
- last recovery command
