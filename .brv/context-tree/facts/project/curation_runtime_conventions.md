---
consolidated_at: '2026-05-27T10:03:18.780Z'
consolidated_from: [{date: '2026-05-27T10:03:18.780Z', path: facts/curation_runtime_conventions/rlm_curation_workflow.md, reason: 'These files describe the same canonical RLM curation workflow with overlapping instructions on precomputed recon, single-pass handling, chunked mapExtract fallback, bare taskId usage, timeout 300000, no raw-context printing, verification via applied file paths, and UPSERT preference. The full note and the existing project convention file are redundant representations of one workflow policy, so they should be consolidated into the richer canonical convention note.'}, {date: '2026-05-27T10:03:18.780Z', path: facts/project/curate_rlm_workflow_context.md, reason: 'These files describe the same canonical RLM curation workflow with overlapping instructions on precomputed recon, single-pass handling, chunked mapExtract fallback, bare taskId usage, timeout 300000, no raw-context printing, verification via applied file paths, and UPSERT preference. The full note and the existing project convention file are redundant representations of one workflow policy, so they should be consolidated into the richer canonical convention note.'}]
related: [facts/project/context.md]
---
# Title: Curation Runtime Conventions

## Summary
Canonical runtime guidance for RLM curation sessions: use precomputed recon, choose single-pass for small contexts, fall back to chunked mapExtract only when needed, and verify results through applied file paths rather than filesystem reads.

## Core Workflow
precomputed recon -> inspect suggestedMode -> single-pass curate or chunked extraction -> curate with UPSERT -> verify result.applied[].filePath -> report status

## Must-Preserve Rules
- Do NOT print raw context.
- Do NOT call tools.curation.recon when recon has already been computed.
- If suggestedMode is single-pass, proceed directly to extraction/curation and skip chunking.
- For chunked extraction, use tools.curation.mapExtract().
- When using mapExtract, pass taskId as a bare variable, not a string.
- Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself.
- Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extracted facts.
- Verify via result.applied[].filePath; do NOT call readFile for verification.
- Prefer UPSERT for durable knowledge entries.
- Verify success via result.summary.failed === 0 when available.

## Canonical Facts to Preserve
- Single-pass mode is recommended when recon suggests it for small contexts.
- Chunked extraction is reserved for larger contexts.
- Precomputed recon is the source of truth for mode selection.
- Verification should rely on curated result output, not rereading files.
- Session variables may include context, history, metadata, and task ID names that should be used directly.

## Temporal Note
This guidance has appeared in multiple curation sessions over time; the canonical file should preserve the newest and most complete wording while noting that older session-specific entries existed and were later consolidated.

## Facts
- Single-pass mode is recommended when recon suggests it for small contexts.
- Chunked extraction is reserved for larger contexts.
- Precomputed recon is the source of truth for mode selection.
- Verification should rely on curated result output, not rereading files.
- Session variables may include context, history, metadata, and task ID names that should be used directly.

## Additions to Preserve from Overlapping Files
- Earlier sessions recorded the exact required workflow as: recon -> mapExtract -> dedup/group -> curate -> verify applied file paths.
- Verification must rely on result.applied[].filePath and not on readFile.
- Any code_exec call containing mapExtract must set timeout to 300000 at the outer code_exec level.
- mapExtract taskId must be passed as a bare variable.
- do not print raw context; do not call recon again when precomputed recon is already available.
- use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions.
- Later guidance reinforced canonical wording around UPSERT preference and checking result.summary.failed.
- For small pre-reconciled contexts, proceed directly in single-pass mode; chunked extraction is for larger contexts.
