# Project Binding

Project Binding connects one local project root to a remote Caplets runtime so project-bound tools can run against the same files the user is editing.

## Attach Modes

`caplets attach --once` validates Cloud Auth or self-hosted remote credentials, bootstraps `.caplets/.gitignore`, checks the Project Binding endpoint, runs sync preflight when the project root exists, and exits.

`caplets attach` opens a foreground Binding Session. It reports state events, keeps the Project Binding lease alive, and exits only when interrupted or when the session reaches a terminal state.

Hosted Cloud and self-hosted remotes use `caplets remote login <url>` and a saved Remote Profile. Passing `--workspace` must match the saved Selected Workspace; run `caplets remote login <cloud-url> --workspace <workspace>` to select a different workspace.

The attach client connects to the remote `/v1/attach` API for runtime Caplet discovery and calls. `/v1/mcp` remains the ordinary agent-facing MCP endpoint and continues to honor configured exposure policy.

Stacked runtimes use the same project vocabulary. `caplets serve --transport http --upstream-url <url>` starts a long-running HTTP runtime, and each `caplets attach <local-runtime-url>` or native session supplies its own project root. The runtime attempts upstream Project Binding for that session when the upstream supports it, but project-local Caplets are still loaded from the session project root.

## Binding Session Loop

Foreground attach creates a server-side Binding Session through the Project Binding control API, opens the control WebSocket, emits normalized JSON events, sends periodic heartbeats, and sends a remote session-end request when interrupted. A single reconnectable WebSocket close emits a `reconnecting` event before retrying the same Binding Session.

`caplets attach --once` remains finite. It only probes the HTTP equivalent of the WebSocket endpoint and accepts the `websocket_upgrade_required` response as proof that the endpoint is reachable.

Hosted attach refreshes expired local Cloud Auth credentials before creating the Binding Session. If the saved refresh credential has been revoked, attach fails closed and asks the user to log in again.

## States

Binding Session states are:

- `not_attached`
- `attaching`
- `syncing`
- `ready`
- `degraded`
- `blocked`
- `offline`
- `cleaning_up`
- `ended`
- `expired`

Terminal states include a reason with a stable code, message, optional request ID, and recovery command.

## Sync Safety

Sync filtering applies in this order:

- Caplets hard denylist, including `.git`, `node_modules`, `.venv`, caches, build outputs, archives, private keys, and unsafe env files.
- `.gitignore`.
- `.capletsignore`.

Safe env templates remain allowed: `.env.example`, `.env.sample`, and `.env.template`.

Hosted defaults are Free 25 MiB per file and 250 MiB per project, Plus 100 MiB and 1 GiB, Pro 250 MiB and 5 GiB, and Enterprise policy-controlled. Self-hosted defaults to 250 MiB and 5 GiB.

## Recovery

- `cloud_auth_required`: `caplets remote login <cloud-url>`
- `workspace_switch_required`: `caplets remote login <cloud-url> --workspace <workspace>`
- `sync_size_limit_exceeded`: add exclusions to `.capletsignore` or upgrade the workspace plan
- `endpoint_unavailable`: `caplets doctor`
