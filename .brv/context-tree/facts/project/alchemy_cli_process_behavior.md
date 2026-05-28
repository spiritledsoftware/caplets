---
title: Alchemy CLI process behavior
summary: Facts about Alchemy CLI process behavior
tags: []
related: []
keywords: []
createdAt: '2026-05-28T11:56:15.138Z'
updatedAt: '2026-05-28T11:56:15.138Z'
---
## Reason
Curate extracted facts from source context

## Raw Concept
**Task:**
Document extracted facts

**Timestamp:** 2026-05-28T11:56:15.126Z

## Facts
- **Alchemy CLI process behavior**: The shim was loaded in the parent Alchemy CLI, but Alchemy spawns a child process to evaluate `alchemy.run.ts`; the child was not inheriting the `--import` preload.
