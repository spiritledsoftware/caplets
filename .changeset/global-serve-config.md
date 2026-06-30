---
"@caplets/core": patch
"caplets": patch
---

Add top-level user `serve` config defaults for HTTP Caplets serving. Foreground `caplets serve --transport http` and daemon restarts can now reuse configured host, port, path, upstream URL, remote state path, public origins, proxy trust, and unauthenticated HTTP intent while project config ignores `serve` for security.
