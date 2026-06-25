---
"@caplets/core": patch
"caplets": patch
---

Keep daemon service descriptors pointed at the stable `caplets` command instead of pnpm's versioned package target so pnpm updates do not strand installed daemons on removed package paths.
