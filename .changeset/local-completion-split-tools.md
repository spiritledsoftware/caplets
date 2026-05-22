---
"caplets": patch
"@caplets/core": patch
---

Fix local shell completion discovery for downstream tool names and support split `caplets get-tool <caplet> <tool>`, `caplets call-tool <caplet> <tool>`, and `caplets get-prompt <caplet> <prompt>` command forms while preserving existing qualified targets. Preserve the public `CAPLETS_SERVER_URL` origin for remote OAuth callback redirects.
