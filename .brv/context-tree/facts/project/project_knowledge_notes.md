---
title: Project Knowledge Notes
summary: Project knowledge notes covering repository conventions, curated knowledge organization, and workflow expectations.
tags: []
related: []
keywords: []
createdAt: '2026-05-20T13:11:07.251Z'
updatedAt: '2026-05-20T14:01:45.228Z'
---

## Reason

Curate extracted project-wide knowledge from the provided context

## Raw Concept

**Task:**
Curate project-level knowledge and workflow conventions from the provided RLM context.

**Changes:**
- Recorded the current context tree areas relevant to remote control and working module knowledge
- Preserved prior curated areas including packages/core and docs/plans
- Added guarded JSON parsing and protocol validation in RemoteControlClient
- Redacted remote-provided error messages before surfacing CapletsError
- Added regression tests for malformed payloads and secret-like error messages
- Verified the targeted test suite and typecheck commands
- Created fix commit bf60f51
- Preserved working module findings as durable knowledge
- Curated the knowledge into the context tree
- Captured context-tree location and hierarchy rules
- Captured writable vs read-only knowledge source constraints
- Captured UPSERT preference for curation operations

**Files:**
- packages/core/test/remote-control-client.test.ts
- packages/core/src/errors.ts
- .brv/context-tree/
- .brv/context-tree/facts/project/

**Flow:**
context supplied -> extracted conventions and facts -> upserted into durable knowledge

**Timestamp:** 2026-05-20T14:01:37.395Z

**Author:** ByteRover context engineer

## Narrative

### Structure

This knowledge belongs in the facts/project domain because it documents repository-wide operational conventions and curation expectations.

### Dependencies

Depends on the ByteRover context-tree organization and the RLM curation workflow.

### Highlights

Preserves the project knowledge needed to curate future context safely and consistently.

### Rules

Do not print raw context. Do not call recon when recon has already been computed. Verify curation via result.applied[].filePath.

### Examples

Useful for future curation sessions that need to target the local context tree and use UPSERT by default.

## Facts

- **context_tree_root**: The project context tree is stored under .brv/context-tree/ [project]
- **context_tree_depth**: Context tree hierarchy is domain -> topic -> subtopic, with a maximum depth of 2 levels. [convention]
- **context_tree_write_scope**: Only the local .brv/context-tree/ is writable; shared source context trees are read-only. [convention]
- **curate_operation_preference**: UPSERT is the preferred curation operation and auto-detects whether to create or update a file. [convention]
- **curate_content_requirements**: For curation tasks, context content should include rawConcept and narrative sections, with at least one of changes, files, or flow in rawConcept. [convention]
