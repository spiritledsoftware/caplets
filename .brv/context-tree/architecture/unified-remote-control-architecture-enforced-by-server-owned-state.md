---
confidence: 0.94
sources: [architecture/_index.md, facts/_index.md, facts/_index.md]
synthesized_at: '2026-05-27T23:38:23.762Z'
type: synthesis
title: Unified Remote‑Control Architecture Enforced by Server‑Owned State
summary: Remote‑control design centralizes state on the server and standardizes command interfaces across CLI, API, and UX layers.
tags: [remote-control, server-state, cli, api]
related: []
keywords: [remote, control, server, state, cli, api, sanitization, boundary, commands, ux]
createdAt: '2026-05-27T23:38:23.762Z'
updatedAt: '2026-05-27T23:38:23.762Z'
---

# Unified Remote‑Control Architecture Enforced by Server‑Owned State

Both the architecture and facts domains document a server‑owned, secret‑free remote boundary with structured control commands, reinforcing a consistent remote‑control model across implementation, review, and runtime conventions.

## Evidence

- **architecture**: Core architecture describes a server‑owned, secret‑free remote boundary with structured control commands.
- **facts**: Review outcomes (e.g., task_7_review_outcome) verify sanitization and server‑owned field boundaries for remote control.
- **facts**: Remote‑control review/outcome entries emphasize server‑side validation and redaction of client‑supplied fields.
