---
title: Completion Auth Fallback Behavior
summary: Completion should return stale cached results when available, otherwise static/config fallback only, with no auth diagnostics in output.
tags: []
related: []
keywords: []
createdAt: '2026-05-21T16:21:08.210Z'
updatedAt: '2026-05-21T16:21:08.210Z'
---
## Reason
Document durable decision about completion behavior when remote discovery is blocked by auth

## Raw Concept
**Task:**
Document completion behavior when live discovery requires remote/downstream authentication

**Changes:**
- Agreed that completion must not trigger interactive auth flows
- Return stale cache first, otherwise static/config fallback
- Keep auth hints out of completion output
- Document that caplets auth login <server> enables richer remote completions

**Flow:**
completion request -> live discovery blocked by auth -> return stale cache if present -> otherwise return static/config fallback

**Timestamp:** 2026-05-21T16:20:57.900Z

## Narrative
### Structure
A completion-time policy for remote discovery failures caused by auth requirements.

### Dependencies
Applies when downstream auth blocks live discovery during shell completion.

### Highlights
Treat completions as candidate generation only; do not surface diagnostics in the shell output.

## Facts
- **completion_auth_flow**: No interactive auth flows should run during completion. [convention]
- **completion_fallback_behavior**: Completions should return stale cached results if available when live discovery is blocked by remote/downstream auth. [convention]
- **completion_fallback_behavior**: If cached results are unavailable, completions should return the static/config fallback only. [convention]
- **completion_output_format**: Completion output should not include special auth hints or diagnostics because shells expect candidates, not diagnostics. [convention]
- **remote_completion_documentation**: Documentation can note that `caplets auth login <server>` enables richer remote completions. [project]
