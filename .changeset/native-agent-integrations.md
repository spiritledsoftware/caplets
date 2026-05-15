---
"@caplets/core": patch
"@caplets/opencode": patch
"@caplets/pi": patch
---

Native integrations now share the hot-reload runtime so existing native tools execute against
the latest valid Caplets config; Pi can register newly added Caplet tools and deactivate stale
ones at runtime when its active-tool APIs are available.
