---
title: RLM Curation Runtime Conventions
summary: Runtime conventions for RLM curation, including recon-first workflow, single-pass handling for small contexts, mapExtract chunking for larger contexts, and verification via applied file paths.
tags: []
related: [facts/conventions/context.md]
keywords: []
createdAt: '2026-05-20T13:23:05.390Z'
updatedAt: '2026-05-20T18:39:31.988Z'
---
## Reason
Document runtime curation constraints and workflow requirements from the current RLM context.

## Raw Concept
**Task:**
Curate RLM approach instructions for context-driven curation.

**Changes:**
- Established single-pass curation for the current context.
- Captured the required variable names for context, history, metadata, and task ID.
- Recorded verification guidance to use applied file paths rather than readFile.
- Established recon-first workflow
- Defined single-pass handling for small contexts
- Specified mapExtract timeout and taskId handling
- Defined verification using applied file paths
- Single-pass mode should be used when recon suggests it.
- Reconstruction step is already precomputed and should not be repeated.
- Verification should use applied file paths rather than readFile.
- Established recon-first decision flow
- Defined chunked mapExtract handling for larger contexts
- Standardized UPSERT-based curation and verification
- Specified that recon is mandatory before curation when mode is not already known.
- Defined single-pass handling as a two-call flow.
- Defined chunked handling with mapExtract, deduplication, and grouping.
- Defined verification by applied file paths and zero failed operations.
- Defined single-pass handling for small contexts.
- Recorded chunked extraction requirements for mapExtract.
- Recorded verification and status reporting expectations.
- Use precomputed recon when available
- Skip chunking in single-pass mode
- Pass taskId as a bare variable to mapExtract
- Verify results through applied file paths
- Recorded that recon is precomputed and single-pass is the recommended mode for this context.
- Captured the requirement to avoid printing raw context during curation.
- Captured the taskId and timeout requirements for mapExtract-based extraction.
- Use pre-computed recon when available and proceed directly to extraction.
- Single-pass mode is appropriate for the 1402-character, 31-line context.
- Use mapExtract with taskId only when chunking is required.
- Verify curation via result.applied[].filePath without readFile-based verification.

**Files:**
- .brv/context-tree/
- .brv/context-tree/facts/conventions/

**Flow:**
recon -> extract -> dedup/group -> curate -> verify

**Timestamp:** 2026-05-20T18:39:26.083Z

**Author:** ByteRover context engineer

**Patterns:**
- `^300000$` - Required timeout value for code_exec calls containing mapExtract

## Narrative
### Structure
The instructions define an RLM curation workflow with a pre-computed recon result, a single-pass recommendation, and explicit verification guidance.

### Dependencies
Depends on sandbox variables for context, history, metadata, and taskId; uses tools.curation helpers and tools.curate.

### Highlights
Emphasizes not printing raw context, not calling recon again, and using groupBySubject and dedup when extraction results need organization.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been precomputed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId as a bare variable. Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself. Verify via result.applied[].filePath — do NOT call readFile for verification.
