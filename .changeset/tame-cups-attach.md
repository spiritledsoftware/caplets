---
"@caplets/core": patch
"caplets": patch
---

Preserve the caller's Caplets config paths when running `caplets attach` so local overlay handles come from the intended `CAPLETS_CONFIG` instead of the default user config. Local overlay Code Mode handles now execute locally when attached to a remote service.
