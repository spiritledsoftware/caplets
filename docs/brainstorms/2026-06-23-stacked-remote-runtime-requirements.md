---
date: 2026-06-23
topic: stacked-remote-runtime
---

# Stacked Remote Runtime Requirements

## Summary

Add a stacked HTTP runtime shape where `caplets serve --transport http --upstream-url <url>` serves local Caplets together with an upstream Caplets host, while `caplets attach <url>` becomes a stdio-only session client that supplies project context to the runtime it connects to.

---

## Problem Frame

Codex MCP server startup does not reliably inherit the user's shell environment or pass expected environment variables through to server commands. That makes env-interpolated Caplets config fragile when Codex launches `caplets serve` or `caplets attach` directly.

Caplets already has pieces that point away from env-dependent child startup: Remote Profiles keep remote credentials out of agent config, the Caplets Daemon models runtime launch as an install-time service contract, Remote Attach composes local and remote capabilities, Project Binding connects a local project root to a remote runtime, and Namespace Shadowing keeps local/upstream ID collisions predictable.

The desired product shape is to move durable runtime responsibility into a local HTTP service that owns env, Vault, auth, logs, reloads, and health. Agent-facing `attach` should be a thin stdio session adapter rather than another long-lived server command with its own HTTP transport.

---

## Key Decisions

- **Stacked runtime is a `serve` role.** `caplets serve --transport http --upstream-url <url>` starts the composed runtime because it publishes an HTTP service for clients.
- **Remote session adapter is an `attach` role.** `caplets attach <url>` stays the command installed into MCP clients and always speaks stdio to the launching client.
- **Use `--upstream-url`, not `--remote-url`, on `serve`.** The flag names the server behind the local runtime rather than implying this process itself is the remote target.
- **Project context is session-scoped.** The long-running HTTP runtime must not treat its startup CWD as the active project for every client.
- **`caplets attach` uses CWD for project context.** Native integrations may pass an explicit project root through their API; the CLI attach adapter should default to its launch CWD.
- **Existing shadowing semantics stay authoritative.** Upstream Caplet `shadowing` policy decides collision behavior: `forbid` suppresses local same-ID Caplets, `allow` permits local bare-ID use, and `namespace` qualifies both sides.
- **Upstream Project Binding is automatic.** When a session supplies a project root and the upstream supports Project Binding, the stacked runtime should attempt binding without another flag.

---

## Actors

- A1. **Agent user:** Wants Codex and native integrations to see stable Caplets without hand-wiring env secrets into MCP config.
- A2. **MCP client:** Launches `caplets attach <url>` and communicates over stdio.
- A3. **Local stacked runtime:** Runs `caplets serve --transport http --upstream-url <url>` and composes local, project, and upstream Caplets.
- A4. **Upstream Caplets host:** Publishes remote capabilities, shadowing policy, Remote Profile requirements, and Project Binding support.
- A5. **Native integration:** Starts a Caplets session with an explicit project root when its host API exposes one.

---

## Requirements

**Command model**

- R1. `caplets serve --transport http --upstream-url <url>` must start an HTTP runtime that composes local Caplets with the trusted upstream runtime at `<url>`.
- R2. `caplets attach <url>` must expose stdio only to the launching MCP client and must not support HTTP serving options as the public attach contract.
- R3. `caplets attach <url>` must use its launch CWD as the session project root unless an explicit project root override is provided for tests or native integration plumbing.
- R4. Native integrations must be able to supply project root explicitly and fall back to CWD only when no host-provided root exists.

**Composition and shadowing**

- R5. The stacked runtime must expose a resolved surface containing local user/global Caplets, session project Caplets, and upstream Caplets.
- R6. The stacked runtime must apply existing upstream-authored shadowing semantics for every local/upstream base-ID collision.
- R7. Namespace-qualified IDs must use durable source identity and configured namespace aliases consistently across local and upstream sources.
- R8. Stacked composition must fail closed with diagnostics when a namespace collision cannot be resolved safely.

**Project Binding**

- R9. When a session has a project root and the upstream advertises Project Binding support, the stacked runtime must attempt upstream Project Binding automatically.
- R10. If upstream Project Binding fails, local project Caplets and non-project upstream Caplets should remain available when safe, with a degraded diagnostic that points to recovery.
- R11. Project context must be per session so one long-running local runtime can serve clients from different repositories without project leakage.

**Credentials and env ownership**

- R12. Agent configs must continue to contain stable non-secret selectors such as `caplets attach <url>`, not bearer tokens, passwords, or copied env secrets.
- R13. The stacked runtime must resolve upstream credentials from Remote Profiles and local config secrets from Caplets-owned runtime mechanisms.
- R14. Upstream credentials, remote Vault values, and local env-derived config must not be mirrored into agent-visible config or session metadata.

**Diagnostics and compatibility**

- R15. Attach help and errors must guide users from removed HTTP attach usage toward `caplets serve --transport http --upstream-url <url>`.
- R16. Serve help, docs, and generated setup guidance must teach `--upstream-url` for stacked runtimes.
- R17. `caplets doctor` should distinguish local runtime health, upstream Remote Profile health, and upstream Project Binding health.

---

## Key Flows

- F1. **Start stacked runtime**
  - **Trigger:** User or daemon starts `caplets serve --transport http --upstream-url <url>`.
  - **Actors:** A1, A3, A4
  - **Steps:** The runtime resolves local config, resolves the upstream through Remote Profiles, starts HTTP service endpoints, and prepares to compose per-session project context.
  - **Outcome:** Clients can attach to one local HTTP runtime that represents local plus upstream capabilities.

- F2. **Attach from a project**
  - **Trigger:** MCP client launches `caplets attach <local-runtime-url>` from a repository root.
  - **Actors:** A2, A3
  - **Steps:** The attach adapter sends stdio to the client, supplies its CWD as session project root, and consumes the resolved runtime surface from the local runtime.
  - **Outcome:** The client sees the composed Caplets surface for that repository without Codex launching env-sensitive server commands.

- F3. **Compose a collision**
  - **Trigger:** Local or project Caplet ID matches an upstream Caplet ID.
  - **Actors:** A3, A4
  - **Steps:** The runtime reads the upstream Caplet shadowing policy and applies `forbid`, `allow`, or `namespace` behavior.
  - **Outcome:** The visible Caplet IDs match current shadowing rules and never silently choose an ambiguous namespace collision.

- F4. **Bind upstream project context**
  - **Trigger:** A session supplies project root and upstream Project Binding is available.
  - **Actors:** A3, A4
  - **Steps:** The stacked runtime starts Project Binding automatically, syncs per existing safety rules, and attaches upstream project-bound capabilities when ready.
  - **Outcome:** Remote project-bound Caplets can operate against the same project context while local project Caplets remain local.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R6.** Given Hosted #1 publishes `filesystem` with `shadowing: allow`, `github` with `shadowing: forbid`, and `browser` with `shadowing: namespace`, when Hosted #2 runs `caplets serve --transport http --upstream-url <hosted-1-url>` with local Caplets of the same IDs, then `filesystem` is locally available, `github` routes to upstream, and `browser` is exposed only through qualified IDs.
- AE2. **Covers R2, R15.** Given a user runs `caplets attach <url> --transport http`, then the command refuses HTTP attach serving and points to `caplets serve --transport http --upstream-url <url>`.
- AE3. **Covers R3, R11.** Given two MCP clients launch `caplets attach <local-runtime-url>` from different repository roots, then the stacked runtime resolves project Caplets independently for each session.
- AE4. **Covers R9, R10.** Given upstream Project Binding is unavailable, when a session attaches with a project root, then local project Caplets and non-project upstream Caplets remain available and diagnostics report degraded Project Binding.
- AE5. **Covers R12, R13, R14.** Given an agent config launches `caplets attach <local-runtime-url>`, then upstream credentials are resolved from Remote Profiles and no credential material is embedded in the agent config.

---

## Scope Boundaries

- The first version targets one `--upstream-url` per stacked runtime; arbitrary fan-in across many upstreams is deferred.
- This does not replace Namespace Shadowing semantics; it must reuse and preserve them.
- This does not make `caplets attach` a daemon installer or service manager.
- This does not require hosted Cloud for local stacked usage.
- This does not expose local shell env or Vault values to upstream hosts except through explicit, existing runtime contracts.

---

## Dependencies / Assumptions

- Remote Profiles remain the source of truth for self-hosted and Cloud upstream credentials.
- Existing attach and native service code can be reused or refactored so `serve --upstream-url` does not create a parallel composition engine.
- Project Binding safety rules from `docs/project-binding.md` remain in force for upstream sync.
- Namespace Shadowing requirements in `docs/brainstorms/2026-06-23-namespace-shadowing-policy-requirements.md` are either implemented first or implemented as a prerequisite slice.

---

## Outstanding Questions

### Deferred to Planning

- What compatibility window should `caplets attach --transport stdio` receive before the flag is fully rejected?
- What exact session metadata shape should carry project root from stdio attach and native integrations to an HTTP stacked runtime?
- What cycle detection and maximum stack depth should protect `--upstream-url` chains?

---

## Sources / Research

- `STRATEGY.md` anchors this under the Remote runtime and Project Binding track.
- `CONCEPTS.md` defines Remote Attach, Remote Login, Remote Profile, Namespace Shadowing Policy, Caplets Daemon, and Vault boundaries.
- `packages/core/src/cli.ts` currently exposes `--transport`, HTTP bind flags, and `--remote-url` on `caplets attach`.
- `packages/core/src/attach/options.ts` currently resolves attach remote selection together with serve transport options and CWD-derived project root.
- `packages/core/src/attach/server.ts` currently lets remote-backed attach serve either stdio or HTTP.
- `packages/core/src/native/service.ts` already composes remote and local tools, applies namespace exposure, and uses local/project config paths for namespace identity.
- `docs/project-binding.md` defines current Project Binding attach behavior and recovery states.
