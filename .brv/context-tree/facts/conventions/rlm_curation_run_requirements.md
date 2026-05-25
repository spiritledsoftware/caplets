---
title: RLM Curation Run Requirements
summary: RLM curation run requirements covering single-pass handling, context safety, verification, and curation workflow expectations.
tags: []
related: [facts/conventions/rlm_curation_single_pass_mode.md, facts/conventions/rlm_curation_run_conventions.md, facts/conventions/context.md]
keywords: []
createdAt: '2026-05-25T10:03:04.676Z'
updatedAt: '2026-05-25T11:23:15.737Z'
---
## Reason
Curate single-pass RLM curation requirements and conventions from the provided context

## Raw Concept
**Task:**
Document the RLM curation run requirements and execution conventions for this single-pass curation context.

**Changes:**
- Use recon-suggested single-pass mode for small contexts
- Pass taskId as a bare variable to mapExtract
- Set the outer code_exec timeout to 300000 ms for mapExtract
- Verify curation via result.applied[].filePath without readFile
- Captured the precomputed recon result usage for single-pass handling
- Captured the required timeout rule for mapExtract calls
- Captured the verification rule using applied file paths
- Recorded pre-computed recon usage for single-pass mode
- Recorded timeout requirement for mapExtract tool calls
- Recorded verification rule using applied file paths
- Recorded the precomputed recon result and single-pass recommendation
- Captured the requirement to avoid printing raw context
- Captured verification guidance using applied file paths

**Flow:**
precomputed recon -> single-pass curation -> curate UPSERT -> verify applied file paths -> report status

**Timestamp:** 2026-05-25T11:23:05.351Z

**Author:** ByteRover context engineer

**Patterns:**
- `^single-pass$` - Suggested mode for the provided compact context

## Narrative
### Structure
This knowledge covers how to handle an RLM curation run when the context is small enough for a single-pass operation.

### Dependencies
Depends on the precomputed recon result, the provided context/history/metadata variables, and the curation API.

### Highlights
Single-pass mode was recommended. The instructions emphasize not printing raw context, not re-running recon, and verifying success from applied file paths.

### Rules
Do NOT print raw context. Do NOT call tools.curation.recon. Proceed directly to extraction. Verify via result.applied[].filePath.

## Facts
- **curation_mode**: The context is small enough for single-pass curation. [convention]
- **recon_status**: Recon was already computed before curation and suggested single-pass mode. [convention]
- **context_logging_policy**: The curation workflow must not print raw context. [convention]
- **verification_method**: Verification must use result.applied[].filePath and not readFile. [convention]
