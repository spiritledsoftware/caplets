---
"@caplets/core": minor
"@caplets/sdk": minor
"@caplets/opencode": patch
"@caplets/pi": patch
"caplets": minor
---

Add the resource-oriented Current Host Admin API, public OpenAPI 3.1 document, and generated Fetch client. Launch `@caplets/sdk` 0.1.0 with ordered streaming bundle helpers and the browser-safe Project Binding coordinator. Model each Current Host as an HTTP(S) origin with fixed `/.well-known/caplets`, `/api`, `/mcp`, and `/dashboard` namespaces; require origin-only configuration; move public HTTP and Admin resources under `/api`; and remove path-prefix serving, the v1 Admin transport, legacy Caplets Cloud/hosted modes, route fallbacks, and JSON/base64 bundle transfer. Preserve exclusive bearer-or-dashboard-session authorization, CSRF protection, root-path dashboard cookie migration, durable backend OAuth flows, and atomic SQL-backed administration across Host Nodes.
