---
"@caplets/core": patch
---

Fix dashboard mutation refresh ordering so rejected work cannot suppress successful state, pending revokes cannot expose stale client data, and the latest successful completion controls the rendered Current Host data.
