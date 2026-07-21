---
"@caplets/core": minor
"@caplets/sdk": minor
"caplets": minor
---

Add the resource-oriented v2 Current Host Admin API, public OpenAPI 3.1 document, and generated Fetch client. Launch `@caplets/sdk` 0.1.0 as an independent generated client for the canonical public HTTP API, with ordered streaming bundle helpers, the browser-safe Project Binding v1 coordinator, and the Node-only marker-aware fingerprint helper. Migrate dashboard, core, and CLI callers to isolated SDK clients and remove the unreleased `@caplets/core/admin-client` path. Dashboard and remote Operator clients retain separate authentication ceremonies. Freeze and deprecate v1 Admin compatibility, reject remote `init` and `add`, and replace JSON/base64 Caplet bundles with ordered streaming multipart transfer.
