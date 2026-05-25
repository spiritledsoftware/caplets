---
title: Console Logging Policy
summary: Production code must not use console.log or similar logging because it can leak messages into native TUIs such as opencode, pi, and codex.
tags: []
related: [facts/project/curation_runtime_conventions.md]
keywords: []
createdAt: '2026-05-25T11:13:26.206Z'
updatedAt: '2026-05-25T11:13:26.206Z'
---
## Reason
Capture the project rule to remove console.log and similar from production code

## Raw Concept
**Task:**
Document the prohibition on console.log in production code

**Changes:**
- Added a production logging restriction to prevent leaks into native TUIs

**Flow:**
production code -> avoid console.log -> prevent message leakage into native TUIs

**Timestamp:** 2026-05-25T11:13:13.676Z

## Narrative
### Structure
This is a project-level rule governing logging behavior in production code.

### Dependencies
Applies to native TUI environments including opencode, pi, and codex.

### Highlights
The stated reason is to prevent leakage of messages into terminal user interfaces.

## Facts
- **production_console_logging_policy**: Production code must not use console.log or similar logging. [convention]
- **native_tui_logging_risk**: Console logging can leak messages into native TUIs such as opencode, pi, and codex. [project]
