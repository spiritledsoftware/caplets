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

**Code Mode bridge value**:
A value passed between a Code Mode script and a Caplets backend call, including JSON-compatible data and supported standard-library binary payload objects.
_Avoid_: JSON-only payload, host object leak

**Google Discovery API backend**:
A Caplets backend family for Google APIs whose machine-readable contract is a Google Discovery document rather than an OpenAPI document.
_Avoid_: Discovery backend, discovery document backend, OpenAPI-backed Google API

**Media artifact**:
A file-backed Caplets result for response content that should not be returned inline, such as binary media or oversized textual content.
_Avoid_: Inline blob, base64 result, download blob
