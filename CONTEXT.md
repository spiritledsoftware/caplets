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
A paired remote client whose role allows dashboard and admin operations against the Caplets host, including remote-client administration, Caplet installation and configuration, and Vault administration.
_Avoid_: Admin device token, dashboard token

**Current Host**:
The Caplets host that served the active dashboard session and owns the runtime state being administered in that session.
_Avoid_: Only server, global host singleton

**Operator Activity Log**:
A host-owned record of sensitive Operator Client actions performed through the dashboard or operator admin surfaces.
_Avoid_: Daemon logs, compliance audit system
