---
"@caplets/core": patch
"caplets": patch
---

Replace self-hosted Remote Login's operator-minted Pairing Code bootstrap with a client-started pending login flow. The client now starts `caplets remote login <url>`, displays a short operator code, waits for server-local approval, rotates pre-login material while pending, and stores final Remote Profile credentials only after approval. Remote attach recovery now reports revoked self-hosted credentials and Cloud workspace ambiguity with stable recovery guidance, and public docs/examples show the pending-login approval sequence without remote secrets in agent configuration.
