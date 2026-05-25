---
title: Curation Runtime Conventions
summary: Curation runtime conventions covering RLM workflow, single-pass recon guidance, mapExtract usage, UPSERT preference, verification requirements, and context quality rules.
tags: []
related: []
keywords: []
createdAt: '2026-05-22T10:00:59.917Z'
updatedAt: '2026-05-22T10:00:59.917Z'
---
## Reason
Capture runtime conventions and workflow constraints from the provided curation context

## Raw Concept
**Task:**
Document the runtime conventions and workflow rules for curation in this environment

**Changes:**
- Captured RLM curation workflow guidance
- Recorded single-pass handling when recon recommends it
- Recorded verification and UPSERT preferences

**Flow:**
recon -> extract if needed -> curate -> verify

**Timestamp:** 2026-05-22T10:00:48.913Z

**Author:** ByteRover context engineer

## Narrative
### Structure
The guidance defines how to process curation contexts, including when to use single-pass versus chunked extraction and how to verify applied results.

### Dependencies
Depends on recon output, tools.curation.mapExtract() for chunked contexts, and tools.curate() for final knowledge writes.

### Highlights
The context emphasizes not printing raw context, using bare taskId for mapExtract when needed, and checking curation summaries for failures.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon when recon has already been pre-computed. For chunked extraction use tools.curation.mapExtract(). Pass taskId as a bare variable, not a string. Verify via result.applied[].filePath — do NOT call readFile for verification.

## Facts
- **curation_workflow**: For curation tasks, use the RLM approach with recon, extraction, and curate phases. [convention]
- **single_pass_mode**: When recon suggests single-pass, skip chunking and curate directly. [convention]
- **default_curate_operation**: Use UPSERT by default for curation operations. [convention]
- **chunked_extraction_tool**: If a context is chunked, use tools.curation.mapExtract() for parallel extraction. [convention]
- **curation_verification**: Verify curation results via result.summary.failed and result.applied[].filePath. [convention]

---

# Title: Curation Runtime Conventions

## Purpose
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
