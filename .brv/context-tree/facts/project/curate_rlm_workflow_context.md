---
title: Curate RLM workflow context
summary: 'RLM curation run requirements: use recon results, prefer single-pass for small contexts, preserve facts, verify applied file paths, and report final status from curate results.'
tags: []
related: []
keywords: []
createdAt: '2026-05-25T11:56:56.637Z'
updatedAt: '2026-05-25T11:56:56.637Z'
---
## Reason
Capture durable curation workflow requirements and execution order from the provided RLM context.

## Raw Concept
**Task:**
Document the required RLM curation workflow for this run.

**Changes:**
- Use precomputed recon output only
- Proceed directly to extraction or single-pass curation
- Verify applied file paths from curate results
- Report final status with summary and verification

**Flow:**
precomputed recon -> extract or single-pass curate -> verify applied file paths -> report status

**Timestamp:** 2026-05-25T11:56:48.655Z

**Author:** ByteRover context engineer

## Narrative
### Structure
This context captures run-specific RLM instructions, including the required execution order, timeout rule for mapExtract, and verification constraints.

### Dependencies
Depends on precomputed recon metadata and history variables supplied for the current task.

### Highlights
Suggested mode is single-pass with one chunk. The run must avoid rereading raw context and must verify output via curate application metadata.

## Facts
- **curation_mode**: The current curation run uses RLM approach with precomputed recon and single-pass mode. [convention]
- **recon_usage**: For single-pass contexts, do not call tools.curation.recon again. [convention]
- **mapextract_timeout**: When mapExtract is used in code_exec, the timeout must be set to 300000 on the tool call itself. [convention]
- **verification_method**: Verification for curation should use result.applied[].filePath and not readFile. [convention]
- **task_id_variable**: The task id for this run is provided as a bare variable named __taskId_c163554f_d585_4615_9584_4e2b6c8d2fec. [other]
