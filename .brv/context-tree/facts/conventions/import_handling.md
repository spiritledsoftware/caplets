---
title: import handling
summary: Facts about import_handling
tags: []
related: []
keywords: []
createdAt: '2026-05-27T13:47:55.376Z'
updatedAt: '2026-05-27T13:47:55.376Z'
---
## Reason
Extracted from source context

## Raw Concept
**Task:**
Curate extracted factual statements

**Changes:**
- Stop changing back to node module resolution imports. I removed the `.js` from imports for a reason so the bundler uses it
- Understood. I reverted the `@modelcontextprotocol/sdk/...` imports back to the extensionless form and will not change them again. The package-boundary failure from that expectation is intentionally not a blocker for this work.

**Timestamp:** 2026-05-27T13:47:55.375Z

## Narrative
### Highlights
Extracted 2 facts for import_handling

## Facts
- **import_handling**: Stop changing back to node module resolution imports. I removed the `.js` from imports for a reason so the bundler uses it
- **import_handling**: Understood. I reverted the `@modelcontextprotocol/sdk/...` imports back to the extensionless form and will not change them again. The package-boundary failure from that expectation is intentionally not a blocker for this work.
