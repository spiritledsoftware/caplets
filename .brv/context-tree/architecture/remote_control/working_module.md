---
title: Working Module
summary: Working module notes for caplets, highlighting active curation, included caplet areas, and durable-note separation practice.
tags: []
related: [architecture/remote_control/unified_environment_variable_interface.md, architecture/remote_control/cli_remote_mode_selection.md, architecture/remote_control/remote_control_api_shape.md, architecture/auth/remote_auth_and_state_ownership.md, architecture/remote_control/context.md]
keywords: []
createdAt: '2026-05-20T11:16:46.330Z'
updatedAt: '2026-05-20T13:22:13.573Z'
---

## Reason

Curate the working module notes from the provided RLM context

## Raw Concept

**Task:**
Document the working module for caplets and its curation status.

**Changes:**
- Captured the current working module notes for durable knowledge.
- Recorded the spec path and commit identifier.
- Recorded the self-review status and format check blocker.
- Captured the command-semantic control model for remote orchestration
- Recorded the unified environment variable interface for mode selection and remote credentials
- Preserved remote auth and server-owned state constraints
- Identified the working module as actively curated during curate sessions
- Captured included caplet areas: GitHub, GitHub CLI, Linear, Repo CLI, and Context7
- Recorded the practice of separating durable notes from raw source snippets

**Flow:**
curate session -> inspect working module notes -> separate durable notes from source snippets -> preserve curated knowledge

**Timestamp:** 2026-05-20T13:22:08.097Z

## Narrative

### Structure

This knowledge captures the working module as a curated area related to caplets and their supporting documentation.

### Dependencies

Relies on caplets-related documentation and prior curation sessions for continuity.

### Highlights

The working module is treated as an actively curated knowledge area, with emphasis on durable notes instead of raw source snippets.

### Rules

Remote mode must keep tokens and secrets server-owned. Structured /control endpoints are used instead of raw CLI-string execution.

### Examples

Example endpoints include /healthz for liveness, /mcp for MCP access, /control for command semantics, and /control/auth/callback/:flowId for auth callback handling.

## Facts

- **caplets_working_module_scope**: The working module for caplets currently includes a caplets package with GitHub, GitHub CLI, linear, repo CLI, and Context7-related documentation. [project]
- **working_module_status**: The working module is actively curated and surfaced during curate sessions. [project]
- **working_module_curation_practice**: Session fff205ed separated durable notes from raw source snippets while curating the working module. [project]
