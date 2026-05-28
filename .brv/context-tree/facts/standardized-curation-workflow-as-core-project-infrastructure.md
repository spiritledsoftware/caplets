---
confidence: 0.92
sources: [facts/_index.md, project/_index.md]
synthesized_at: '2026-05-27T23:38:23.764Z'
type: synthesis
title: Standardized Curation Workflow as Core Project Infrastructure
summary: The project formalizes a recon‑first, UPSERT‑based curation pipeline used across facts and project domains.
tags: [curation, workflow, upssert, recon]
related: []
keywords: [curation, recon, upssert, extraction, verification, workflow, runtime, infrastructure, knowledge, automation]
createdAt: '2026-05-27T23:38:23.764Z'
updatedAt: '2026-05-27T23:38:23.764Z'
---

# Standardized Curation Workflow as Core Project Infrastructure

Both the facts domain and the project domain describe the same durable curation workflow (recon → extraction → UPSERT → verification), making it a reusable infrastructure component for knowledge management.

## Evidence

- **facts**: Curation/runtime conventions define recon‑first analysis, single‑pass or chunked extraction, and UPSERT with verification.
- **project**: RLM curation workflow records the canonical process, emphasizing recon‑first, UPSERT, and `result.summary.failed === 0` verification.
