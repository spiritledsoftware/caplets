---
title: RLM Single-Pass Curation Run Requirements
summary: 'RLM curation run requirements for small contexts: precomputed recon, single-pass processing, no raw context printing, mapExtract timeout and taskId handling, and verification via file paths.'
tags: []
related: []
keywords: []
createdAt: '2026-05-24T15:45:50.096Z'
updatedAt: '2026-05-24T15:45:50.096Z'
---
## Reason
Capture the curation run instructions provided in the prompt as durable conventions.

## Raw Concept
**Task:**
Document the RLM curation run requirements for this session

**Changes:**
- Use single-pass mode for the provided small context
- Do not rerun recon because it was already computed
- Preserve the instruction to avoid raw context printing
- Use the specified mapExtract timeout and bare taskId variable rule
- Verify applied file paths after curation

**Flow:**
recon precomputed -> extract relevant facts -> curate with UPSERT -> verify applied file paths -> report status

**Timestamp:** 2026-05-24T15:45:38.847Z

**Author:** ByteRover RLM curation instructions

## Narrative
### Structure
This note captures the execution constraints for an RLM curation run on a small, pre-reconciled context.

### Dependencies
Depends on the precomputed recon output, the provided task ID variable, and the curate result object for verification.

### Highlights
The run is explicitly single-pass and should not use recon again; if mapExtract is used in future runs, the tool-call timeout must be 300000 ms.

### Rules
Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId as a bare variable, not a string. IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options). Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions. Verify via result.applied[].filePath — do NOT call readFile for verification.
