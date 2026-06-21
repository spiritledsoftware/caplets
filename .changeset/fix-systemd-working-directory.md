---
"@caplets/core": patch
---

Fix Linux daemon service unit generation so systemd accepts the daemon working directory path, and make daemon install/start health checks reject bind hosts that are not available on the local machine.
