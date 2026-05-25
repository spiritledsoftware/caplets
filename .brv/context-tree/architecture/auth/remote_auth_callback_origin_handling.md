---
title: Remote Auth Callback Origin Handling
summary: Remote auth callback URLs now use CAPLETS_SERVER_URL public origin via publicOrigin, fixing http downgrade behind TLS termination.
tags: []
related: [architecture/auth/remote_auth_and_state_ownership.md, architecture/auth/remote_auth_review_findings.md]
keywords: []
createdAt: '2026-05-22T10:15:09.673Z'
updatedAt: '2026-05-22T10:15:09.673Z'
---
## Reason
Document the remote OAuth callback origin fix, root cause, tests, and verification outcomes.

## Raw Concept
**Task:**
Document the remote OAuth callback scheme fix for caplets auth login

**Changes:**
- Identified a remote OAuth redirect scheme downgrade from HTTPS to HTTP
- Preserved the public origin from CAPLETS_SERVER_URL in serve options
- Updated callback URL generation to prefer the configured public origin
- Added regression coverage for HTTPS public origin handling

**Flow:**
CAPLETS_SERVER_URL -> resolveServeOptions -> publicOrigin -> auth callback URL generation -> browser redirect

**Timestamp:** 2026-05-22T10:14:33.825Z

## Narrative
### Structure
This fix lives in the remote auth / HTTP serve path. The server now carries a publicOrigin value from CAPLETS_SERVER_URL so callback URLs preserve the externally visible HTTPS scheme even when the inbound request is plain HTTP.

### Dependencies
Depends on HTTP serve option resolution and remote auth callback URL construction. Existing proxy behavior remains available when no public origin is configured.

### Highlights
The bug was confirmed by a redirect URL using http:// on a HTTPS deployment. The final verification gate passed, including 39 test files and 538 tests.

### Rules
Auth callback URL generation now uses the configured public origin when present. Preserve existing proxy behavior when no public origin is configured.

### Examples
Example bug: redirect_uri=http%3A%2F%2Fcaplets.tail7ff085.ts.net%2Fcontrol%2Fauth%2Fcallback%2F... despite CAPLETS_SERVER_URL being https://caplets...

## Facts
- **remote_auth_callback_scheme_bug**: Remote `caplets auth login` OAuth flow generated a redirect URL using `http://` even when `CAPLETS_SERVER_URL` was `https://...`. [project]
- **root_cause**: The root cause was that `resolveServeOptions` used `CAPLETS_SERVER_URL` for bind host/path but discarded the public scheme and origin. [project]
- **callback_url_source**: Auth callback URLs were previously reconstructed from the inbound HTTP request URL, which becomes `http://...` behind TLS termination unless proxy headers are trusted. [project]
- **public_origin_fix**: The fix added `publicOrigin` to HTTP serve options, derived from `CAPLETS_SERVER_URL`. [project]
- **callback_origin_policy**: Auth callback URL generation now uses the configured public origin when present and preserves existing proxy behavior when no public origin is configured. [project]
- **regression_tests**: Regression tests were added to ensure `resolveServeOptions` preserves `https://...` public origin from `CAPLETS_SERVER_URL` and remote auth login callback redirects use that HTTPS origin. [project]
- **verification_status**: Verification passed for targeted tests, formatting, linting, typecheck, and the full verification gate. [project]
- **verification_counts**: The full verification run reported 39 test files and 538 tests passed. [project]
- **intermittent_unrelated_failure**: The focused package-script run briefly encountered an unrelated OpenAPI timeout/protocol race, but the new auth callback tests did not fail in that run. [project]
- **unrelated_dirty_files**: The repository had dirty `.brv` and `.opencode/opencode.json` files that were not part of the fix. [project]
