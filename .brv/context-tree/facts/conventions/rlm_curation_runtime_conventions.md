---
title: RLM Curation Runtime Conventions
summary: RLM curation conventions covering precomputed recon, single-pass processing, mapExtract timeout/taskId handling, and verification via curated file paths
tags: []
related: [facts/conventions/context.md]
keywords: []
createdAt: '2026-05-20T13:23:05.390Z'
updatedAt: '2026-05-20T14:04:41.372Z'
---
## Reason
Document runtime curation rules and workflow requirements for RLM-based processing

## Raw Concept
**Task:**
Document the curation workflow conventions for RLM-based context processing in this repository.

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

**Files:**
- .brv/context-tree/
- .brv/context-tree/facts/conventions/

**Flow:**
recon -> single-pass extraction -> curate -> verify applied file paths -> report status

**Timestamp:** 2026-05-20T14:04:33.645Z

**Author:** ByteRover context engineer

**Patterns:**
- `^300000$` - Required timeout value for code_exec calls containing mapExtract

## Narrative
### Structure
This knowledge belongs in the facts/conventions domain because it documents operating rules for curation rather than product behavior.

### Dependencies
Depends on the precomputed recon result and the sandbox variables provided for this curation task.

### Highlights
Single-pass mode is appropriate because the context is small; verification should rely on curate application results instead of rereading files.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId as a bare variable. Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself. Verify via result.applied[].filePath — do NOT call readFile for verification.

## Facts
- **repository_and_knowledge_system**: The repo is called caplets and uses a .brv context tree for curated knowledge. [project]
- **curation_workflow**: The current curation workflow uses the RLM approach with recon already precomputed and single-pass recommended. [convention]
- **mapextract_timeout_and_taskid**: For chunked extraction, mapExtract must receive the taskId as a bare variable and code_exec calls using mapExtract must use a 300000 ms timeout. [convention]
