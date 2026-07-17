# ADR 0003: Split Remote Client Roles Between Access And Operator Authority

## Status

Accepted

## Context

One paired credential previously authorized both agent/runtime access and broad host administration. That made an ordinary MCP, Attach, or Project Binding credential unnecessarily powerful and blurred the difference between invoking configured capabilities and changing the Current Host that serves them.

The SQL control plane also makes availability part of authorization. A cached runtime snapshot can support a narrow stale read during storage loss, but it cannot prove that a remote client, role, security epoch, or writer fence is still live. Administration must therefore be reauthorized against current SQL authority rather than inferred from a cached projection.

The first dashboard administers the Current Host: the Caplets host that served the dashboard session. The model remains host-scoped so a future multi-host view can select another host without redefining credential authority.

Source code remains the source of truth. This ADR records the durable role and adapter boundaries.

## Decision

Paired remote credentials have one server-side Remote Client Role:

- An **Access Client** may use `/v1/mcp`, Attach, and Project Binding.
- An **Operator Client** is a strict Access superset and may additionally use `/v1/admin` and authorized dashboard administration.

Current Host administration includes read-only administrative queries as well as mutations: remote-client administration, Caplet catalog/install/configuration and portable import/export, host settings, Vault administration, diagnostics, operation lookup, and Operator Activity. These operations require a live Operator principal and current SQL authority.

MCP, Attach, Code Mode, OpenCode, Pi, and other native agent projections remain non-administrative. They render the Caplets exposure projection and may invoke allowed runtime capabilities, but they do not receive Current Host, storage, migration, backup/restore, key-management, import/export, or credential-administration tools.

The dashboard and `/v1/admin` are separate adapters over `packages/core/src/current-host/operations.ts`. The dashboard owns browser session cookies, CSRF, same-origin navigation, human confirmations, and presentation. `/v1/admin` owns Operator bearer authentication and the safe `RemoteCliRequest` response envelope. Neither adapter owns the semantic authorization policy.

Raw Vault Reveal is not a shared Current Host operation. It remains dashboard-only, requires explicit human confirmation, returns `Cache-Control: no-store`, and expires in browser presentation state. Generic Operator bearer administration rejects reveal.

Both Access and Operator Clients may revoke only their own credential through the role-neutral self-revoke route. Broader client administration requires Operator authority.

Pending Remote Login records the requested role. The approving local operator grants that role by default and may override it before credentials are issued.

Local `--global` CLI operations are not remote-client operations. They are explicit, trusted, potentially destructive actions against the local process's global/Current Host scope. A selected remote profile does not redirect them. Crossing to a paired host requires `--remote`, and administrative remote actions require an Operator Client.

The unauthenticated health endpoint remains availability-independent and redacted to backend/readiness/connectivity/migration, authority/effective generation, bootstrap compatibility, stale age, convergence, and a guidance code. Detailed store, fingerprint, key, backup, or node diagnostics require a live-authorized Operator dashboard session.

## Consequences

- Compromise of an Access Client does not grant host administration.
- An Operator Client can use the Access surfaces without holding a second credential.
- Read-only administrative requests are still Operator-only; Access Clients inspect callable capability surfaces through MCP and Attach instead.
- Warm stale runtime reads never authorize admin, auth, Attach, Project Binding, Vault, import/export, or mutation.
- Adapter-specific authentication and confirmation ceremony stays outside the Current Host semantic module.
- Local automation must opt into `--global` for destructive Current Host scope and `--remote` for paired-host scope.
- Storage maintenance and recovery remain trusted local orchestration capabilities rather than remote or agent tools.

## Evidence

- `packages/core/src/remote/server-credentials.ts` defines `access`, `operator`, and Operator-as-Access role inclusion.
- `packages/core/src/serve/http.ts` applies Access authentication to MCP, Attach, and Project Binding, and Operator authentication to `/v1/admin`.
- `packages/core/src/current-host/operations.ts` owns semantic Current Host authorization and redacted responses.
- `packages/core/src/control-plane/service.ts` requires live authority for admin/import/export and marks the maintenance coordinator as local-only.
- `packages/core/src/control-plane/health.ts` enforces the public health field allowlist.
- `packages/core/src/serve/http.ts` keeps raw Vault Reveal on the human dashboard path with `no-store`.
