---
title: Curation Runtime Conventions
summary: 'Defines the RLM curation workflow: recon, single-pass handling for small contexts, mapExtract for chunked contexts, UPSERT-based curation, and verification via applied file paths and result.summary.'
tags: []
related: [architecture/remote_control/context.md]
keywords: []
createdAt: '2026-05-20T12:47:22.778Z'
updatedAt: '2026-05-20T13:09:19.427Z'
---
## Reason
Capture runtime curation workflow and verification conventions from context

## Raw Concept
**Task:**
Document the runtime curation conventions used for RLM processing

**Changes:**
- Identified single-pass mode as the recommended approach
- Recorded mapExtract taskId passing requirement
- Recorded code_exec timeout requirement for mapExtract calls
- Captured required tool-use constraints
- Recorded RLM single-pass guidance
- Preserved verification and context-handling rules
- Confirmed the context should be handled in single-pass mode.
- Preserved the requirement to pass taskId as a bare variable when using mapExtract.
- Captured the verification rule to check applied file paths instead of reading files back.
- Recorded the recon -> single-pass or chunked extraction workflow
- Captured the preferred UPSERT curation pattern
- Preserved the verification rule using applied file paths and result.summary

**Flow:**
recon -> choose single-pass or chunked extraction -> curate with UPSERT -> verify applied file paths and summary

**Timestamp:** 2026-05-20T13:09:12.305Z

**Author:** ByteRover context engineer

## Narrative
### Structure
Curation runtime conventions are organized as procedural guidance for how to process context, extract facts, and apply knowledge tree updates.

### Dependencies
Relies on the RLM curation workflow, tools.curation.recon, tools.curation.mapExtract, tools.curation.dedup, tools.curation.groupBySubject, and tools.curate.

### Highlights
Small contexts should be handled in single-pass mode. Chunked contexts require mapExtract, deduplication, grouping by subject, and verification through applied file paths.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon when it has been pre-computed. For chunked extraction use tools.curation.mapExtract(). Pass taskId as a bare variable, not a string. Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions. Verify via result.applied[].filePath — do NOT call readFile for verification.

## Facts
- **curation_workflow**: Use recon as the first step in RLM curation workflow. [convention]
- **curation_mode**: For small contexts, suggestedMode single-pass should skip chunking. [convention]
- **chunked_extraction**: For chunked contexts, use mapExtract with taskId passed as a bare variable and timeout 300000 on the code_exec call. [convention]
- **curate_operation**: Use UPSERT as the preferred curation operation. [convention]
- **verification**: Verify curation via result.applied[].filePath and result.summary.failed. [convention]
