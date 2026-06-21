---
"@caplets/core": minor
"caplets": minor
"@caplets/opencode": minor
"@caplets/pi": minor
---

Replace self-hosted remote env-token and Basic Auth setup with unified Remote Login profiles. Remote attach, hosted Cloud, OpenCode, and Pi now resolve Caplets-owned credentials from `caplets remote login <url>` and use `CAPLETS_REMOTE_URL` only as a non-secret selector.
