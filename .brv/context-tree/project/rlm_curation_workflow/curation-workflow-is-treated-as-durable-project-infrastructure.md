---
confidence: 0.98
sources: [facts/_index.md, project/_index.md]
synthesized_at: '2026-05-26T19:23:43.119Z'
type: synthesis
title: Curation workflow is treated as durable project infrastructure
summary: The same recon-first, verify-by-file-path curation process is codified as both a facts policy and a project workflow.
tags: [curation, workflow, verification, facts, project]
related: []
keywords: [recon, upsert, mapextract, dedup, verify, filePath, failed, context]
createdAt: '2026-05-26T19:23:43.119Z'
updatedAt: '2026-05-26T19:23:43.119Z'
---

# Curation workflow is treated as durable project infrastructure

Across facts and project, curation is not chat-only: it is a durable workflow with recon-first analysis, single-pass vs. chunked extraction, dedup/grouping, UPSERT-first updates, and verification via `result.applied[].filePath` plus `result.summary.failed === 0`.

## Evidence

- **facts**: Runtime curation guardrails require single-pass mode for compact contexts, chunked `mapExtract` only for larger contexts, no raw context printing, bare `taskId`, outer `code_exec` timeout 300000 ms, UPSERT preference, and verification through `result.applied[].filePath` and `result.summary.failed`.
- **project**: The curation workflow is described as recon-first, then single-pass or chunked extraction, then dedup/groupBySubject, with verification using `result.applied[].filePath` and no rereading files just to confirm.
