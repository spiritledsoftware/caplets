# Project Binding

Project Binding connects one local project root to a Caplets runtime so project-bound tools can run against the same project the user is editing.

Project Binding is session context first and file sync second. Local-only `serve`, daemon-backed
local sessions, and native local sessions use the bound project root as execution context for
project-bound CLI and stdio MCP Caplets; they do not start file sync. Direct generic remotes and
stacked upstream remotes use the same session context plus Mutagen-backed sync when project files
need to be available on the Current Host.

## Attach Modes

`caplets attach --once` validates the selected Remote Profile credentials, bootstraps
`.caplets/.gitignore`, checks the Project Binding endpoint, runs sync preflight when the project root
exists, and exits.

`caplets attach` opens a foreground Binding Session. It reports state events, keeps the Project Binding lease alive, and exits only when interrupted or when the session reaches a terminal state.

Generic remotes use `caplets remote login <origin>` and a saved Remote Profile. The value is a
Current Host Origin such as `https://host.example`; non-root paths, queries, fragments, and
credentials are rejected before network access.

The attach client connects to `/api/v1/attach/*` for runtime Caplet discovery and calls. Exact
`/mcp` remains the ordinary agent-facing MCP endpoint and continues to honor configured exposure
policy.

Stacked runtimes use the same project vocabulary.
`caplets serve --transport http --upstream-url <origin>` starts a long-running HTTP runtime, and
each `caplets attach <local-runtime-origin>` or native session supplies its own project root.
Project-local Caplets are loaded from the session project root. Upstream project-bound Caplets stay
hidden until the Current Host advertises Project Binding metadata and the session's Mutagen sync
policy is enforceable.

## Binding Session Loop

Foreground attach creates a server-side Binding Session through the Project Binding control API, opens the control WebSocket, emits normalized JSON events, sends periodic heartbeats, and sends a remote session-end request when interrupted. A single reconnectable WebSocket close emits a `reconnecting` event before retrying the same Binding Session.

`caplets attach --once` remains finite. It only probes the HTTP equivalent of the WebSocket endpoint and accepts the `websocket_upgrade_required` response as proof that the endpoint is reachable.

Attach refreshes expired generic Remote Profile credentials before creating the Binding Session. If
the saved refresh credential has been revoked, attach fails closed and asks the user to complete
Remote Login again.

Current Host Project Binding routes live under `/api/v1/attach/project-bindings`. The WebSocket
connect endpoint is `/api/v1/attach/project-bindings/connect`; session create, status, heartbeat,
and session close routes share the Attach credential boundary. Binding records are owned by the
attach/native session or Remote Profile identity that created them; another client cannot heartbeat
or close a binding it does not own.

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

Upstream Project Binding sync uses Mutagen. Caplets computes a sync manifest first, translates the include/exclude policy into Mutagen ignore configuration, and blocks exposure if that policy cannot be enforced. A Mutagen session reporting ready is not sufficient unless the sync policy was applied before the session started.

Sync filtering applies in this order:

- Caplets hard denylist, including `.git`, `node_modules`, `.venv`, caches, build outputs, archives, private keys, and unsafe env files.
- `.gitignore`.
- `.capletsignore`.

Safe env templates remain allowed: `.env.example`, `.env.sample`, and `.env.template`.

The Current Host's Project Binding policy supplies the file and project size bounds. Sync preflight
enforces those bounds after exclusions; it never treats remote sync as unbounded.

## Callable Surfaces

Project-bound Caplets are callable only when the current attach/native session has valid Project Binding context. Missing context, invalid `cwd`, unsupported binding, failed auth/trust, missing upstream metadata, sync policy failure, sync failure, retry exhaustion, and quarantine hide affected Caplets from progressive MCP tools, direct tools/resources/prompts, Code Mode declarations, native tools, attach manifests, CLI listings, and completions.

Quarantine is per affected Caplet, not per runtime. Healthy local Caplets, local project-bound Caplets with valid context, and non-project upstream Caplets can remain available while diagnostics report which project-bound Caplets were withheld. Calls through stale attach exports, native route IDs, Code Mode handles, or cached completions fail before backend execution with a Project Binding diagnostic.

## Recovery

- `remote_credentials_required`: `caplets remote login <origin>`
- `sync_size_limit_exceeded`: add exclusions to `.capletsignore` or follow the Current Host policy
- `project_binding_missing_context`: reconnect through `caplets attach` or a native session with project context
- `project_binding_invalid_cwd`: keep explicit `cwd` values inside the bound project root
- `project_sync_policy_denied`: adjust `.gitignore` or `.capletsignore` so the sync policy can be enforced
- `endpoint_unavailable`: `caplets doctor`
