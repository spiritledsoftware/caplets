---
"@caplets/core": minor
---

Expand the Code Mode tool contract with optional `sessionId` reuse, `meta.sessionId` run metadata, and recovery history lookup through `recoveryRef`.

Sessions are live reuse affordances for iterative Code Mode runs; this does not provide durable heap persistence across host restarts.
