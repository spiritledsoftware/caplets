---
"@caplets/core": minor
caplets: minor
---

Add composable shared storage for self-hosted deployments: select one global provider-shaped filesystem, SQLite, PostgreSQL, or S3-compatible `storage` configuration while composing immutable staged Caplets. The core runtime now exposes async storage assembly, generation/health coordination, Storage-facing dashboard management, and explicit inventory, migration, backup, restore, and cutover operations. Document provider prerequisites and keep AWS S3/Cloudflare R2 live validation separate from deterministic PostgreSQL/MinIO evidence.
