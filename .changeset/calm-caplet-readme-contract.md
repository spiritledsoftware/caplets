---
"@caplets/core": minor
---

Make Caplet YAML frontmatter the sole runtime configuration contract while preserving the Markdown body as operator-facing README content for catalog rendering. Remove `body` from the exported runtime configuration types and backend projections, add semantic runtime fingerprints and no-op reload gating, and classify trusted README-only install changes as `content_updated` without setup approval or runtime churn.

**Migration required:** `useWhen` and `avoidWhen` have been removed from Caplet and configured-action schemas. Move concise agent-facing capability context into `description`; move operator-only prerequisites, safety guidance, troubleshooting, and references into the Markdown body. Existing configuration that still declares either removed field is rejected.
