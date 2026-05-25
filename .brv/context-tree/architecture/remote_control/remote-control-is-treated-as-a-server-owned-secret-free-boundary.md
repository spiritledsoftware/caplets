---
confidence: 0.97
sources: [architecture/_index.md, facts/_index.md]
synthesized_at: '2026-05-21T23:23:26.213Z'
type: synthesis
title: Remote control is treated as a server-owned, secret-free boundary
summary: Remote control flows consistently keep auth state and secrets on the server while the client only coordinates login and command routing.
tags: [remote-control, auth, secrets, server-state]
related: []
keywords: [remote, auth, tokens, secrets, server-owned, client, control, boundary]
createdAt: '2026-05-21T23:23:26.213Z'
updatedAt: '2026-05-21T23:23:26.213Z'
---

# Remote control is treated as a server-owned, secret-free boundary

Across architecture and facts, remote control is modeled as a strict boundary: the server owns durable remote-mode state, tokens, and backend definitions, while local clients only initiate login/logout and must never receive secrets. This is reinforced by the structured `/control` API and the repository’s curation rules that preserve durable boundary facts and verify them explicitly.

## Evidence

- **architecture**: Remote-mode ownership says the server owns all Caplets state in remote mode, including config, `.caplets` files, installed Caplets, backend definitions, OAuth/token storage, and reload/watch lifecycle; local clients only coordinate login/logout and must never receive secrets.
- **facts**: The repository preserves durable architecture and review facts about remote-control boundaries, including server-side redaction, secret-free remote responses, and approved verification of remote control behavior.
