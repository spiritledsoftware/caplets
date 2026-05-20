---
title: Curate Runtime Conventions
summary: Runtime curation conventions for RLM workflow, precomputed recon usage, no raw context printing, and verification via applied file paths.
tags: []
related: [facts/project/project_knowledge_notes.md]
keywords: []
createdAt: '2026-05-20T13:18:52.099Z'
updatedAt: '2026-05-20T15:10:55.420Z'
---

## Reason

Capture the runtime curation workflow and verification rules from the provided RLM context.

## Raw Concept

**Task:**
Document the runtime conventions for curating context with the RLM approach.

**Changes:**
- Captured the precomputed recon workflow
- Recorded single-pass handling for small contexts
- Recorded timeout and verification requirements for mapExtract and curate
- Established recon precomputation as the starting point
- Defined single-pass as the default for small contexts
- Specified chunked extraction requirements when needed
- Use precomputed recon results instead of recomputing reconnaissance.
- Proceed directly to extraction for single-pass contexts.
- Use mapExtract only when chunked extraction is needed.
- Verify curation through result.applied[].filePath rather than readFile.

**Flow:**
recon precomputed -> extract facts -> curate UPSERT -> verify applied file paths -> record progress

**Timestamp:** 2026-05-20T15:10:46.102Z

## Narrative

### Structure

The guidance describes an RLM curation workflow with a single-pass path for small contexts and chunked extraction for larger ones.

### Dependencies

Depends on precomputed recon variables, the curate tool, and optional curation helpers such as mapExtract, groupBySubject, and dedup.

### Highlights

The context explicitly forbids printing raw context, prefers direct extraction, and requires verification through the curate result object.

### Rules

IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been precomputed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId: __taskId_57b46e01_4a31_431c_8d92_e7ea01360858 (bare variable, not a string). Verify via result.applied[].filePath — do NOT call readFile for verification.
