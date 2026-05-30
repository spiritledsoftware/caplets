# Caplets Cloud Hosted Product Design

## Status

Approved product and architecture design from brainstorming and grilling session. Implementation plan is intentionally separate.

## Goal

Define the hosted Caplets product that lets users authenticate, configure tools once, expose a remote OAuth-protected MCP endpoint, and run Caplets remotely without operating their own server.

The product should drive conversion through two concrete promises:

- Connect once across agent clients.
- Show agents a smaller, staged tool surface instead of a giant flat tool wall.

Caplets Cloud should serve solo developers first, while using workspace-shaped data boundaries so team workspaces can be added later.

## Non-goals

- Do not replace local Caplets or remove local mode.
- Do not make Basic Auth part of the hosted product surface.
- Do not make hosted UI design decisions outside the Caplets product design system.
- Do not require users to understand Mutagen or manually configure sync sessions.
- Do not expose project-bound Caplets to remote-only clients that cannot use them.
- Do not include task sequencing, milestones, or checklists in this spec. Those belong in a separate implementation plan.

## Product Positioning

Caplets Cloud is not generic "managed MCP hosting." It is a hosted capability layer for coding agents.

The core promise is:

```text
Connect once. Show agents less.
```

The hosted product should make setup speed and tool-surface reduction visible:

- One hosted MCP URL per workspace.
- OAuth-based remote MCP connection flows for supported clients.
- Hosted connector setup for common developer tools.
- Session-aware tool lists that hide unusable capabilities.
- Per-workspace Tool Surface Report showing the reduction from flat tools to Caplet cards.

The Tool Surface Report should be modeled on the existing deterministic benchmark but calculated from the user's actual workspace when possible:

- Direct downstream tools hidden behind Caplets.
- Visible Caplet count.
- Initial payload or approximate context-surface estimate.
- Duplicate tool-name collisions avoided.
- Discovery trace such as `search_tools -> get_tool -> call_tool`.

Claims must remain precise. Caplets Cloud can claim reduced initial MCP tool-surface payload and fewer initially visible candidate tools. It must not claim a universal provider bill reduction without provider-specific evidence.

## Workspace Boundary

`workspace` is the primary hosted tenant boundary.

All hosted state is scoped to a workspace:

- Hosted Caplet definitions.
- Hosted connector configuration.
- Provider credentials and secret vault entries.
- MCP OAuth client grants and sessions.
- Local presence registrations.
- Runtime leases.
- Tool-surface reports.
- Sync/apply receipts.
- Audit events.
- Usage and billing records.

Solo v1 gives a user one personal workspace. Team support later adds members, roles, audit trails, shared billing, and policy controls to the same workspace object.

## Hosted Authentication

Hosted MCP access is OAuth-only.

Basic Auth remains appropriate for local and self-hosted `caplets serve --transport http`, but hosted onboarding and hosted client configuration must not use Basic Auth.

Hosted MCP authentication requirements:

- Workspace MCP endpoints require OAuth.
- MCP clients authorize through an MCP-compatible OAuth flow where supported.
- Dynamic client registration should be supported where required by MCP-compatible clients.
- Access tokens are scoped to workspace, client/session, and allowed capability surface.
- Token revocation and session invalidation are first-class.
- Hosted web account login is separate from MCP client authorization, though both map to the same workspace.

Provider auth is also workspace-scoped but separate from MCP client auth. For example, GitHub or Linear credentials live in the hosted secret vault and are used by hosted connectors. Local/project auth remains local when local overlays execute locally.

## Execution Classes

Caplets Cloud supports multiple execution classes behind one logical workspace MCP endpoint.

### Hosted Connectors

Hosted connectors run fully in cloud and require no local project presence. Examples include:

- GitHub
- Linear
- Sourcegraph
- OSV
- npm
- PyPI
- Documentation and search connectors

The connector catalog should avoid an empty first-run experience. Each connector should have connect, test, inspect, and status states.

### Hosted Remote MCP And API Caplets

Hosted remote Caplets call external services from cloud:

- Streamable HTTP MCP servers.
- Legacy HTTP/SSE MCP servers where supported.
- OpenAPI endpoints.
- GraphQL endpoints.
- Explicit HTTP action Caplets.

Hosted secrets and provider auth are used only server-side and must not be exposed through generated tool descriptions, logs, or errors.

### Hosted Stdio And CLI Caplets

Hosted stdio MCP servers and CLI Caplets run in managed sandbox runtimes. This is an MVP differentiator because many useful MCP servers remain stdio-only.

The runtime must not assume one workspace container can be vertically resized while running. Treat stdio and CLI backends as schedulable workloads:

- A workspace may use one or more ephemeral sandboxes.
- Each sandbox runs a Caplets supervisor plus assigned backend processes.
- Idle child processes stop first.
- Empty sandboxes sleep or stop after a short idle window.
- Heavy backends can be restarted in larger sandboxes when needed.

### Project-Bound Remote Stdio And CLI Caplets

Project-bound remote Caplets run in hosted sandboxes but sync and apply against a local project through an active local Caplets runtime.

This is for tools that need project files but benefit from remote execution or remote-client availability.

### Local Overlays

Existing local overlay behavior remains central:

- In remote mode, the effective surface is remote first, then user-global local, then project-local.
- User-global and project-local Caplets run locally.
- Local Caplets shadow hosted Caplets by ID.
- Project-local Caplets have the highest priority.

This behavior already exists for native integrations and CLI remote mode and should be treated as a core product feature.

## Session-Aware Capability Availability

Hosted MCP tool lists are session-aware.

Remote-only sessions see only hosted-capable Caplets. Project-bound Caplets are hidden unless a compatible local presence is online for the workspace. Agent-facing tool lists should not include capabilities that will fail immediately because the current session cannot execute them.

Availability rules:

- `executionTarget: "hosted"` is visible to remote-only sessions.
- `executionTarget: "project-bound"` is visible only when compatible local presence exists.
- `executionTarget: "auto"` is visible when hosted execution or project-bound execution is currently available.
- Local developer sessions continue to see the merged remote/local surface.
- Tool-list changes should emit MCP tool-list changed notifications when the transport and client support them.
- Clients that do not refresh dynamically should see the correct surface on the next session.

`caplets doctor` and hosted diagnostics can show hidden Caplets with reasons. The agent-facing surface should hide them.

## Local Presence

A local Caplets runtime in `CAPLETS_MODE=remote` registers local presence for the current project root.

Launching and configuring local Caplets in remote mode is treated as user consent for that local runtime to assist the hosted workspace. No extra per-client approval prompt is required.

Presence is workspace-wide while online, but tightly scoped:

- Same hosted workspace only.
- One current project root per local runtime.
- Project root fingerprint.
- Declared allowed Caplet IDs.
- Sync/apply policy.
- Heartbeat and expiry.
- Audit trail.

Any authenticated remote MCP session in the same workspace may use compatible project-bound Caplets while that presence is online. Users revoke presence by stopping the local runtime, disabling remote mode, changing project policy, or revoking workspace credentials.

## Project Sync

Project-bound remote stdio and CLI execution uses managed project sync.

Mutagen is the MVP sync provider. Caplets bundles and manages it automatically in the local CLI/native integration. Users should not have to install, configure, or operate Mutagen directly.

The user-facing concept is project-bound remote execution.

Sync rules:

- The authoritative filesystem is the bound apply target, not the remote sandbox.
- The remote sandbox mirror is a disposable execution copy.
- Before a mutating remote call, Caplets syncs the mirror from the authoritative target.
- After execution, clean changes sync/apply back to the authoritative target.
- If the mirror becomes suspicious or stale, Caplets can discard and rebuild it from the authoritative target.
- Mutating remote calls are serialized per bound project target in v1.

Sync scope is controlled by project rules:

- Use `.capletsignore` when present.
- Use `.gitignore` and git exclude rules when inside a git repo.
- If not inside a git repo, use `.capletsignore` only.
- Do not invent broad hidden ignore defaults.
- Always exclude Caplets internal sync metadata.
- Secret scanning and size/file-count limits are policy checks, not silent ignore rules.

`caplets doctor` should show the effective sync scope, including ignored files, policy blockers, and Mutagen status.

## Implicit Apply And Conflict Handling

Remote side-effecting tools should feel like normal tools. Clean changes apply implicitly to the bound target.

Flow:

1. Caplets syncs the remote mirror to the authoritative target.
2. The remote stdio or CLI backend runs in the sandbox.
3. Caplets captures the resulting filesystem changes.
4. Caplets applies clean changes back to the authoritative target.
5. The tool result includes an apply receipt.
6. Conflicts or policy violations return structured MCP results.

Apply receipts should include:

- Files created, modified, deleted, and skipped.
- Whether apply was clean.
- Sync version or target fingerprint.
- Runtime and Caplet identifiers.
- Policy warnings.
- Rollback metadata when available.

Conflict results should be recoverable by agents. They should include enough structured data for an agent to inspect the conflict, generate a resolution, and retry without human intervention when safe.

Human intervention is reserved for:

- Secret or policy blocks.
- Unsafe paths.
- Oversized or unsupported changes.
- Repeated unresolved conflicts.
- Explicit workspace policy requiring review.

## Hosted UI Requirements

Hosted UI work must use the `impeccable` workflow for UX shaping, polish, and review.

The hosted app is product UI, not a marketing surface. It should be dense, predictable, inspectable, and calm.

Design requirements:

- Preserve the existing Caplets design system: warm technical surfaces, charred ink, rare ember, ash borders, compact Inter typography, and monospace only for machine-facing content.
- Avoid generic SaaS hero-metric patterns.
- Make the Tool Surface Report feel like a benchmark or inspection artifact, not a celebratory stats grid.
- Use familiar developer-tool affordances: side navigation, tabs, tables, status rows, command snippets, copy buttons, scoped filters, and inline diagnostics.
- Show explicit states for default, loading, empty, connected, degraded, hidden, blocked, conflict, revoked, expired, and unauthorized.
- Use accessible status treatment with no color-only state, visible focus, keyboard navigation, contrast checks, reduced-motion alternatives, and readable dense tables.
- Use progressive disclosure in the UI: show capability, source, status, and next action first; reveal schemas, raw config, OAuth details, sync logs, and patch details only when requested.

Primary hosted workflows:

- Workspace MCP endpoint and OAuth client setup.
- Connector catalog.
- Tool Surface Report.
- Runtime status.
- Local presence and hidden Caplets diagnostics.
- Sync/apply receipts.
- Conflict review and recovery.
- Audit trail.

## `caplets doctor`

`caplets doctor` is the local diagnostic and repair surface. It should show project binding and sync implications only when remote mode is active.

Doctor should report:

- Remote mode configuration.
- Hosted reachability.
- OAuth/token/session status where safe.
- Current project root and project fingerprint.
- Whether local presence is registered.
- Mutagen availability, version, and sync health.
- `.gitignore` and `.capletsignore` effects.
- Secret-scan or quota blockers.
- Hidden project-bound Caplets and why they are hidden.
- Recent apply conflicts or failed syncs.

Doctor should help users understand what the agent cannot see, what the hosted service can execute, and what local project state is currently exposed to Caplets Cloud.

## Security And Trust

Hosted Caplets handles sensitive boundaries:

- OAuth-authenticated MCP clients.
- Hosted provider credentials.
- Local project presence.
- Remote sandbox execution.
- Filesystem sync and implicit apply.

Required controls:

- Hosted MCP uses OAuth, not Basic Auth.
- Hosted provider secrets are encrypted at rest and redacted everywhere.
- Local presence is scoped to one project root and one workspace.
- Project-bound Caplets are hidden unless executable in the current session.
- Remote stdio/CLI execution has process, time, disk, memory, and network limits.
- Mutating operations are audited.
- Secret scanning can block sync/apply.
- Sync metadata and internal control files are never exposed as normal project files.
- Apply operations validate paths and reject traversal or absolute-path writes outside the target.
- Policy blocks are explicit and agent-readable.

## Open Risks

- Mutagen packaging and licensing must be validated. Newer official builds include SSPL-licensed code by default; the MVP must confirm a viable licensing and distribution path.
- Cloud sandbox substrate must be validated for process lifecycle, filesystem semantics, networking, cold start, and cost. Cloudflare sandbox containers are a strong candidate because the repo already uses Cloudflare via Alchemy, but the implementation plan should compare viable substrates.
- MCP OAuth compatibility varies by client. Hosted Caplets should support standard flows and document client-specific limitations.
- Tool-list changed notifications may not be honored by all clients, so availability changes may require a new session in some clients.
- Sync conflict recovery needs careful structured result design so agents can resolve conflicts without overexposing project data.
- Implicit apply is a powerful capability. Workspace policy, doctor output, audit trails, and rollback metadata must make it trustworthy.

## Success Criteria

- A solo developer can create a workspace, authorize an MCP client through OAuth, and connect to one hosted MCP URL.
- The hosted app shows a Tool Surface Report for the workspace.
- Remote-only sessions see only hosted-capable Caplets.
- Local remote-mode sessions see the merged hosted plus local overlay surface.
- Project-bound Caplets become available to workspace sessions while compatible local presence is online.
- Clean remote stdio/CLI changes apply implicitly to the bound project target.
- Conflicts return structured recoverable MCP results.
- `caplets doctor` explains remote mode, local presence, sync state, hidden Caplets, and policy blockers.
- Hosted UI follows the Caplets product design system and uses `impeccable` for UI shaping and review.
