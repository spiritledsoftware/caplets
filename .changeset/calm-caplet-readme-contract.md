---
"@caplets/core": minor
---

Make Caplet YAML frontmatter the sole runtime and agent-selection contract while preserving the Markdown body as operator-facing README content for catalog rendering. Remove `body` from the exported runtime configuration types and backend projections, add semantic runtime fingerprints and no-op reload gating, and classify trusted README-only install changes as `content_updated` without setup approval or runtime churn.
