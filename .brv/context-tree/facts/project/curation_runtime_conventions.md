---
consolidated_at: '2026-05-25T11:38:36.975Z'
consolidated_from: [{date: '2026-05-25T11:38:36.975Z', path: facts/conventions/rlm_curation_run_requirements.md, reason: 'These files all document the same RLM curation runtime policy: precomputed recon, single-pass handling for small contexts, no raw-context printing, mapExtract timeout/taskId rules, UPSERT workflow, and verification via result.applied[].filePath. They are substantially overlapping and should be consolidated into one canonical requirements/conventions note.'}, {date: '2026-05-25T11:38:36.975Z', path: facts/conventions/rlm_curation_run_conventions.md, reason: 'These files all document the same RLM curation runtime policy: precomputed recon, single-pass handling for small contexts, no raw-context printing, mapExtract timeout/taskId rules, UPSERT workflow, and verification via result.applied[].filePath. They are substantially overlapping and should be consolidated into one canonical requirements/conventions note.'}, {date: '2026-05-25T11:38:36.975Z', path: facts/conventions/rlm_curation_single_pass_mode.md, reason: 'These files all document the same RLM curation runtime policy: precomputed recon, single-pass handling for small contexts, no raw-context printing, mapExtract timeout/taskId rules, UPSERT workflow, and verification via result.applied[].filePath. They are substantially overlapping and should be consolidated into one canonical requirements/conventions note.'}, {date: '2026-05-25T11:38:36.975Z', path: facts/conventions/rlm_single_pass_curation_run_requirements.md, reason: 'These files all document the same RLM curation runtime policy: precomputed recon, single-pass handling for small contexts, no raw-context printing, mapExtract timeout/taskId rules, UPSERT workflow, and verification via result.applied[].filePath. They are substantially overlapping and should be consolidated into one canonical requirements/conventions note.'}, {date: '2026-05-25T11:38:36.975Z', path: facts/project/rlm_curation_run_constraints.md, reason: 'These files all document the same RLM curation runtime policy: precomputed recon, single-pass handling for small contexts, no raw-context printing, mapExtract timeout/taskId rules, UPSERT workflow, and verification via result.applied[].filePath. They are substantially overlapping and should be consolidated into one canonical requirements/conventions note.'}]
related: [facts/project/console_logging_policy.md]
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
