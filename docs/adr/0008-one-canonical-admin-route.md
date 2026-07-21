# Use One Canonical Admin Route In A Fixed Origin-Root Topology

Status: accepted

Caplets exposes one fixed protocol topology per Current Host origin. A Current Host URL is an origin (`scheme://host[:port]`), never an origin plus a deployment pathname; path-prefix configuration is unsupported. This amends ADR 0007 and the earlier form of this ADR before the first release: the semantic Admin Module and its credential Adapters remain, but their route seam moves to the fixed namespace below.

The canonical top-level route identities are:

- `GET /` returns `302` with `Location: /dashboard`.
- `GET /.well-known/caplets` is the stable bootstrap document. It uses origin-relative links and is outside OpenAPI and `@caplets/sdk`.
- `/api`, `/api/openapi.json`, `/api/v1/*`, and `/api/v2/admin/*` are the public HTTP namespace. `/api/openapi.json` is the canonical OpenAPI document; it does not describe the well-known document, MCP, dashboard-private ceremonies, or dashboard assets.
- `/mcp` is the exact unversioned MCP endpoint and remains outside OpenAPI.
- `/dashboard` and `/dashboard/*` are the browser application, `/dashboard/_astro/*` its asset namespace, and `/dashboard/api/*` its private login, session, logout, Raw Vault Reveal, and related browser ceremonies.

Route identity is strict and has no trailing-slash normalization. Trailing-slash variants, the old root protocol routes, prefixed deployments, `/dashboard/api/v2`, and every other legacy route return ordinary `404` responses. There are no compatibility aliases, redirects, deprecation handlers, or client fallbacks. The sole redirect is the explicit `GET /` dashboard entry point above. V1 Admin is deleted; only the surviving non-Admin v1 families move beneath `/api/v1/*`.

Only `/api/v2/admin/*` accepts the two deliberately separated Admin credential modes. Any `Authorization` header selects Remote Profile bearer authentication exclusively; invalid or underprivileged bearer credentials fail without cookie fallback. With no `Authorization` header, a `caplets_dashboard_session` cookie selects dashboard-session authentication; those requests must be same-origin, and unsafe methods must also carry the current `X-Caplets-CSRF` value. Verified-loopback `development_unauthenticated` authority is synthesized only when neither credential is present. The selected Adapter produces one request authority containing the Operator principal and any mode-specific successful-mutation finalizer, so resource handlers remain authentication-neutral.

The dashboard session cookie is host-only, HttpOnly, SameSite=Lax, and `Path=/`. Only canonical Admin and dashboard-private ceremonies interpret it. Other `/api/v1/*` and `/mcp` routes retain their route-specific Access Client or Remote Profile credential rules and never gain authority from the dashboard cookie; the public backend OAuth callback continues to authenticate with one-time flow state. OpenAPI describes bearer and dashboard-session cookie schemes as alternatives only for protected Admin operations and describes `X-Caplets-CSRF` there as conditionally required for cookie mode.

[Plan 022, Remove Legacy Caplets Cloud](../plans/022-remove-legacy-caplets-cloud.md), is a prerequisite to the fixed-topology cutover in [Plan 023, Use Fixed-Origin Protocol Namespaces](../plans/023-use-fixed-origin-protocol-namespaces.md). It removes Cloud/hosted product modes and targets, treats every supplied URL as a generic remote, and atomically migrates self-hosted profiles to that generic mode while leaving stored Cloud credentials untouched and unread. The generic Current Host remote Adapter and unrelated Cloudflare/Alchemy deployment infrastructure remain. Plan 023 then integrates Plans 000, 020, 021, and 022 and regenerates OpenAPI, SDK, dashboard, CLI, and documentation artifacts for this topology.

Rejected alternatives are deployment prefixes, multiple Admin mounts, a frozen v1 Admin compatibility Adapter, moving private browser ceremonies into public Admin resources, cross-origin cookie authentication, invalid-bearer cookie fallback, authorizing dashboard sessions on every Operator-capable route, publishing MCP or well-known discovery through OpenAPI, and preserving old paths for compatibility.
