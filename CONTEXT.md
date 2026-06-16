# Caplets

Caplets is a capability gateway for coding agents. This glossary names the product concepts used when describing Caplet configuration and runtime behavior.

## Language

**Google Discovery API backend**:
A Caplets backend family for Google APIs whose machine-readable contract is a Google Discovery document rather than an OpenAPI document.
_Avoid_: Discovery backend, discovery document backend, OpenAPI-backed Google API

**Media artifact**:
A file-backed Caplets result for response content that should not be returned inline, such as binary media or oversized textual content.
_Avoid_: Inline blob, base64 result, download blob
