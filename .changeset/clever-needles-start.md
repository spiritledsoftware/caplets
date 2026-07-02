---
"@caplets/core": patch
"caplets": patch
"@caplets/opencode": patch
"@caplets/pi": patch
---

Fix the published CLI startup path by externalizing jsonc-parser from the Node bundle and checking the built package can answer `caplets --version`.
