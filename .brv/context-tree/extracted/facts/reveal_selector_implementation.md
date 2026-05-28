---
title: reveal selector implementation
summary: Facts about reveal selector implementation
tags: []
related: []
keywords: []
createdAt: '2026-05-27T23:48:05.206Z'
updatedAt: '2026-05-27T23:48:05.206Z'
---
## Reason
Curated extracted facts from context

## Raw Concept
**Task:**
Document factual statements about reveal selector implementation

**Timestamp:** 2026-05-27T23:48:05.172Z

## Facts
- **reveal selector implementation**: Reveal selector update is incomplete: the script now observes `.agent-setup-panel` (`apps/landing/src/pages/index.astro:418-419`), but CSS reveal rules do not include `.agent-setup-panel`, only `.integration-pill` and other existing targets (`apps/landing/src/styles/global.css:690-705`).
