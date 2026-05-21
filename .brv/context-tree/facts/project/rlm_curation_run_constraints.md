---
title: RLM Curation Run Constraints
summary: Runtime curation run constraints for an RLM single-pass context, including task metadata, recon mode, and verification expectations
tags: []
related: []
keywords: []
createdAt: '2026-05-21T10:16:00.571Z'
updatedAt: '2026-05-21T10:16:00.571Z'
---
## Reason
Capture runtime curation instructions and run metadata from the provided context

## Raw Concept
**Task:**
Curate using RLM approach

**Changes:**
- Single-pass mode was recommended by recon
- Context variables and task ID were provided for immediate curation
- Verification must use result.applied[].filePath and avoid readFile

**Flow:**
recon precomputed -> extract facts from provided context -> curate with UPSERT -> verify applied file paths

**Timestamp:** 2026-05-21T10:15:53.911Z

**Author:** ByteRover context engineer

## Narrative
### Structure
This entry records the curation run instructions and execution constraints for a single-pass RLM workflow.

### Dependencies
Depends on the precomputed recon result and the provided context/history/metadata variables.

### Highlights
The context explicitly instructs not to print raw context, not to call tools.curation.recon again, and to verify via result.applied[].filePath.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction. IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options). Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions. Verify via result.applied[].filePath — do NOT call readFile for verification.
