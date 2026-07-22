# Caplets

Caplets is a capability gateway for coding agents. This glossary names the product concepts used when describing Caplet configuration and runtime behavior.

## Language

**Code Mode**:
A Caplets exposure surface where configured backends appear as typed handles inside a bounded script workflow.
_Avoid_: JavaScript shell, Node REPL, sandbox boundary

**Code Mode standard library**:
The safe built-in runtime API surface available to Code Mode scripts for URL, text, byte, binary-payload, timing, and web-compatible data handling without granting host or network access.
_Avoid_: Full Node API, unrestricted host API, local machine access

**Compatibility global**:
A standards-compatible API exposed directly on the Code Mode global scope so ordinary JavaScript examples work without Caplets-specific wrappers.
_Avoid_: Caplets utility namespace, custom helper surface

**Code Mode standard library v1**:
The first compatibility-global set for Code Mode: URL and query handling, text encoding, base64 and Buffer-compatible byte handling, web binary payload objects, safe crypto primitives, timing, scheduling, and structured cloning.
_Avoid_: Minimal encoding helpers, full Node compatibility

**Caplet Record**:
The canonical structured form of a Caplet persisted in runtime-owned storage. A Caplet File is its portable Markdown import/export projection, not the stored record itself.
_Avoid_: SQL Caplet File, stored Caplet File

**Caplet Revision**:
An immutable saved version of a Caplet Record's structured content and Caplet Bundle Snapshot; the record's current Caplet ID is stable metadata outside content history. A record selects one current revision; removing it promotes the newest remaining revision, while removing the sole revision removes the record.
_Avoid_: Mutable draft, audit-log entry

**Caplet Installation**:
A provenance-bearing lifecycle that connects a Caplet Record to an external source and update channel. Detaching ends update tracking without erasing that lifecycle; replacing a detached install starts a new Caplet Installation.
_Avoid_: Global lockfile entry, permanent source ownership

**Caplet Bundle Snapshot**:
A portable normalized snapshot of every regular auxiliary file in a Caplet bundle, including its relative path, content identity, and executable intent; `CAPLET.md` is represented by the Caplet Record instead. Safe in-bundle symlinks become regular files; escaping or broken links and special files are invalid.
_Avoid_: Bundle archive blob, mounted bundle path

**Caplet File Layer**:
A live filesystem-backed source whose Caplet Files can shadow lower-precedence Caplets without modifying them. Project Caplet Files outrank global Caplet Files, which outrank SQL-backed Caplet Records.
_Avoid_: One-time bootstrap import, filesystem synchronization

**Effective Caplet**:
The Caplet selected for an ID after all configured Caplet sources are resolved. Ordinary runtime and dashboard views show only the Effective Caplet; explicit storage operations may still address a shadowed Caplet Record.
_Avoid_: Active record, merged Caplet

**Authoritative Host State**:
The correctness-bearing state owned by a Caplets host that must present one coherent view across all of that host's server nodes. It excludes node-local caches and artifacts, client-owned credentials, and native service files.
_Avoid_: All runtime files, shared cache

**Host Node**:
A running server instance participating in one logical Caplets host. Host Nodes share Authoritative Host State but own their live Code Mode heap, bound workspace copy, and any node-local artifacts.
_Avoid_: Independent host, tenant

**Caplets exposure projection**:
A shared adapter-neutral runtime view of which local and remote Caplets are exposed as Code Mode handles, progressive tools, direct downstream operations, or direct MCP surfaces, including non-callable diagnostic breadcrumbs for hidden Caplets. MCP, native, and attach host adapters render it differently; they do not own exposure policy or execution behavior.
_Avoid_: Tool registration list, exposure wrapper map, transport-specific surface

**Code Mode bridge value**:
A value passed between a Code Mode script and a Caplets backend call, including JSON-compatible data and supported standard-library binary payload objects.
_Avoid_: JSON-only payload, host object leak

**Google Discovery API backend**:
A Caplets backend family for Google APIs whose machine-readable contract is a Google Discovery document rather than an OpenAPI document.
_Avoid_: Discovery backend, discovery document backend, OpenAPI-backed Google API

**Media artifact**:
A file-backed Caplets result for response content that should not be returned inline, such as binary media or oversized textual content.
_Avoid_: Inline blob, base64 result, download blob

**Caplets Vault**:
A runtime-owned encrypted string store whose values can be referenced from Caplets config with `$vault:NAME` or `${vault:NAME}`.
_Avoid_: Caplets Secrets, project secrets, shared encrypted project vault

**Remote Client Role**:
The server-side authorization role assigned to a paired remote client after a Pending Remote Login is approved.
_Avoid_: Device token type, browser permission flag

**Access Client**:
A paired remote client whose role allows Remote Attach, MCP, and Project Binding access without host administration.
_Avoid_: Regular device token, user token

**Operator Client**:
A paired remote client whose role includes every Access Client capability and additionally allows dashboard and host administration, including remote-client administration, Caplet installation and configuration, and Vault administration.
_Avoid_: Admin device token, dashboard token

**Current Host**:
The Caplets host that served the active dashboard session and owns the runtime state being administered in that session.
_Avoid_: Only server, global host singleton

**Current Host Origin**:
The canonical HTTP(S) origin of a Current Host: scheme, host, and optional port, with no credentials, non-root path, query, or fragment. Current Host configuration and clients resolve fixed Protocol Namespaces from this origin.
_Avoid_: Service root, base path, endpoint URL, host URL with path

**Protocol Namespace**:
A fixed origin-root path owned by one Current Host interface: discovery at `/.well-known/caplets`, public HTTP at `/api`, exact MCP at `/mcp`, or browser UI and private ceremonies beneath `/dashboard`. Protocol Namespaces are not deployment or reverse-proxy configuration.
_Avoid_: Configured prefix, relocatable route root, service base path

**Dashboard Session Credential**:
A host-only, HttpOnly browser credential established from an approved Operator Client and accepted only by the canonical Admin API and dashboard-private ceremonies with same-origin and conditional CSRF checks.
_Avoid_: Dashboard token, browser bearer, dashboard-wide authority

**Admin API**:
The canonical `/api/v2/admin/*` HTTP resource interface through which Operator bearer clients and same-origin Dashboard Session Credentials administer the Current Host under explicit credential-mode precedence.
_Avoid_: Remote CLI RPC, dashboard backend, mixed-auth endpoint, dashboard Admin alias

**Caplets SDK**:
The typed client Module for the canonical public Caplets HTTP API and the versioned Attach Project Binding WebSocket session protocol. It excludes MCP and dashboard-private authentication ceremonies.
_Avoid_: Admin client, core client, dashboard session client

**Operator Activity Log**:
A host-owned record of sensitive Operator Client actions performed through the dashboard or operator admin surfaces.
_Avoid_: Daemon logs, compliance audit system
