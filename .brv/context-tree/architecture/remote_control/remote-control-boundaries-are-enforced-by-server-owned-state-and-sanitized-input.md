---
confidence: 0.9
sources: [facts/_index.md, facts/_index.md, project/_index.md]
synthesized_at: '2026-05-26T19:23:43.123Z'
type: synthesis
title: Remote control boundaries are enforced by server-owned state and sanitized inputs
summary: Both facts and project docs frame remote control as a boundary where local-only fields are stripped and server-owned secrets stay protected.
tags: [remote-control, security, sanitization, completion, server-owned]
related: []
keywords: [boundary, sanitization, server-owned, redaction, routing, local-only, remote, auth]
createdAt: '2026-05-26T19:23:43.123Z'
updatedAt: '2026-05-26T19:23:43.123Z'
---

# Remote control boundaries are enforced by server-owned state and sanitized inputs

Across facts and project, remote-control behavior is consistently constrained by a trust boundary: local-only add fields are stripped before remote requests, routing uses only server-owned variables, and completion/remote operations must not leak auth diagnostics or other secret state.

## Evidence

- **facts**: Remote mutation routing confirmed request sanitization, server boundary checks, response parsing, and error redaction; local-only add fields `global`, `print`, `output`, and `destinationRoot` are stripped before remote requests.
- **facts**: Nested `request.operation` validation is confirmed, and remote routing uses only `CAPLETS_MODE` and `CAPLETS_SERVER_URL`.
- **project**: The completion/remote-control workflow distinguishes backend IDs vs tool names by prefix and degrades safely on failures/timeouts, while local hidden completion routes through `CapletsEngine.completeCliWords`.
