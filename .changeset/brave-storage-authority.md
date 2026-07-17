---
"@caplets/core": minor
---

Add the production SQL Current Host control plane with zero-config single-node SQLite and logical-host Postgres cluster backends, paired checked migrations, filesystem bootstrap authority, persistent filesystem/S3 artifact providers, live-authority health and degraded-read semantics, protected migration/recovery/key-rotation contracts, portable Caplet administration, and offline SQLite-to-Postgres transfer boundaries.

Ship the native SQLite driver, Postgres and S3 clients, both migration trees, and the signed Windows legacy-exclusion helper in the packed package. Unsupported native/runtime tuples now fail with actionable matrix guidance, and publish rejects missing, unsigned, wrong-publisher, or checksum-mismatched Windows helpers.

**Migration note:** Existing reviewed global mutable state migrates automatically only when its lockfile, paths, hashes, platform exclusion, backup, and credential-protection proofs are valid. Otherwise stop every old replica and run `caplets storage migrate --global --offline`. Filesystem configuration, untracked Caplets, and project lockfiles remain filesystem-owned.
