---
"@caplets/core": minor
caplets: minor
---

Add composable shared storage for self-hosted deployments: choose one filesystem, SQLite, PostgreSQL, or S3-compatible Writable Authority while composing immutable staged Caplets. The core runtime now exposes async authority assembly, generation/health coordination, dashboard-managed durable state, and explicit inventory, migration, backup, restore, and cutover operations. Document provider prerequisites and keep AWS S3/Cloudflare R2 live validation separate from deterministic PostgreSQL/MinIO evidence.
