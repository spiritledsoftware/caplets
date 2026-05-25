---
title: RLM Curation Single-Pass Mode
summary: RLM curation uses precomputed recon and proceeds directly in single-pass mode when suggestedMode is single-pass.
tags: []
related: [facts/curation_runtime_conventions.md, facts/project/curation_runtime_conventions.md]
keywords: []
createdAt: '2026-05-24T13:52:05.605Z'
updatedAt: '2026-05-24T16:41:52.705Z'
---
## Reason
Capture the operational convention for single-pass RLM curation runs from the provided context.

## Raw Concept
**Task:**
Document the RLM curation execution convention for precomputed recon and single-pass processing.

**Changes:**
- Used precomputed recon result instead of recomputing
- Accepted suggested single-pass mode with one chunk
- Prepared facts from the run metadata and context sizing
- Established that recon is precomputed and should not be called again in this run
- Recorded single-pass mode guidance for small contexts
- Recorded chunked extraction requirements, including taskId and timeout handling
- Recorded verification requirements for curated output
- Use precomputed recon instead of recalculating it during curation
- Proceed directly to extraction when suggestedMode is single-pass
- Use taskId as a bare variable when invoking mapExtract for chunked extraction

**Flow:**
recon precomputed -> inspect suggestedMode -> single-pass extraction/curation -> verify applied file paths

**Timestamp:** 2026-05-24T16:41:43.099Z

**Author:** ByteRover context engineer

## Narrative
### Structure
This knowledge captures the execution rule for RLM curation runs and the requirement to trust the precomputed recon result for mode selection.

### Dependencies
Depends on the precomputed recon variables and the curation runtime conventions for organizing extracted facts.

### Highlights
The provided task explicitly instructed not to call tools.curation.recon again and to verify success using result.applied[].filePath.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId: __taskId_b710f89b_37e2_493b_a382_f6f4c79ac5b3 (bare variable, not a string). IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options). Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions. Verify via result.applied[].filePath — do NOT call readFile for verification.

## Facts
- **rlm_curation_mode**: Curation requests for this task use the RLM approach with precomputed recon and direct single-pass processing when suggestedMode is single-pass. [convention]
- **recon_assessment**: The current context was pre-assessed with suggestedMode single-pass, suggestedChunkCount 1, charCount 2658, lineCount 41, and messageCount 0. [project]
