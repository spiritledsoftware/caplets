---
title: Audit Fixes Summary
summary: Summary of audit fixes including touch targets, reveal motion, integration tabs, and verification steps
tags: []
related: []
keywords: []
createdAt: '2026-05-28T14:07:06.849Z'
updatedAt: '2026-05-28T14:07:06.849Z'
---
## Reason
Document audit fixes performed on landing page

## Raw Concept
**Task:**
Apply audit fixes to landing page

**Changes:**
- Mobile touch targets fixed
- Reveal motion resilience fixed
- Integration tabs hardened
- Repeated kicker scaffolding reduced
- Low-priority hover motion quieted
- Stale --header-shadow token removed
- `.tool-noise` mask no longer uses literal black

**Files:**
- apps/landing/src/pages/index.astro
- apps/landing/src/styles/global.css

**Flow:**
Implement fixes -> Verify typecheck & build -> Browser checks

**Timestamp:** 2026-05-28T14:07:06.844Z

## Narrative
### Structure
Fixes applied to landing page source files and verified via typecheck, build, and visual browser checks

### Highlights
All audit fixes passed verification; mobile touch targets meet 44px minimum, no overflow at 320px and 1440px

### Examples
Implemented all audit fixes via subagent-driven development with implementer and reviewer passes.
Mobile touch targets fixed.
Reveal motion resilience fixed.
Integration tabs hardened with safe progressive enhancement.
Repeated kicker scaffolding reduced.
Low-priority hover motion quieted.
Stale `--header-shadow` token removed.
`.tool-noise` mask no longer uses literal `black`.
Final subagent review approved.
Changed landing files: `apps/landing/src/pages/index.astro` and `apps/landing/src/styles/global.css`.
Verification passed: `pnpm --filter @caplets/landing typecheck`.
Verification passed: `pnpm --filter @caplets/landing build`.
Browser check at `320px` showed no horizontal overflow and no visible `a`/`button` targets below `44px`.
Browser check at `1440px` showed hero remains cleanly wrapped and trace card remains `660px` wide with no trace overflow.

## Facts
- **audit fixes**: Implemented all audit fixes via subagent-driven development with implementer and reviewer passes.
- **mobile touch targets**: Mobile touch targets fixed.
- **reveal motion resilience**: Reveal motion resilience fixed.
- **integration tabs**: Integration tabs hardened with safe progressive enhancement.
- **kicker scaffolding**: Repeated kicker scaffolding reduced.
- **hover motion**: Low-priority hover motion quieted.
- **header-shadow token**: Stale `--header-shadow` token removed.
- **tool-noise mask**: `.tool-noise` mask no longer uses literal `black`.
- **subagent review**: Final subagent review approved.
- **landing files**: Changed landing files: `apps/landing/src/pages/index.astro` and `apps/landing/src/styles/global.css`.
- **typecheck**: Verification passed: `pnpm --filter @caplets/landing typecheck`.
- **build**: Verification passed: `pnpm --filter @caplets/landing build`.
- **320px browser check**: Browser check at `320px` showed no horizontal overflow and no visible `a`/`button` targets below `44px`.
- **1440px browser check**: Browser check at `1440px` showed hero remains cleanly wrapped and trace card remains `660px` wide with no trace overflow.
