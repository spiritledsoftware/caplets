---
"@caplets/core": minor
"@caplets/pi": minor
"caplets": minor
---

Improve Caplets agent-facing result metadata and rendering.

Discovery operations now include Caplet metadata alongside `structuredContent.result`, direct `call_tool` results preserve the downstream shape while adding `_meta.caplets`, compact tool metadata includes stable schema hashes, and browser-style artifact links are surfaced as structured metadata. The Pi integration now renders concise Caplet-aware result summaries with artifact lines and truncated previews.
