# Native Integrations And Project Binding

Native integrations use the same Project Binding vocabulary as the CLI.

Explicit remote mode is eager. If a user configures a remote service and the remote Project Binding path cannot start, the integration fails hard so the caller sees the configuration problem.

Auto or configured hosted behavior is lazy. The native integration can start local Caplets immediately, then attach hosted Project Binding metadata when the remote side becomes available. When the lazy path fails, local Caplets remain available and the warning points to `caplets doctor`.

Native metadata should expose:

- auth mode: `hosted_cloud`, `self_hosted_remote`, or `unconfigured`
- Selected Workspace ID or slug when hosted Cloud Auth is active
- Binding Session state
- Project Binding endpoint
- last recovery command
