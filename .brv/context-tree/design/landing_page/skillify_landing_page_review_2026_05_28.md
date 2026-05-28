---
title: Skillify Landing Page Review 2026-05-28
summary: 'Review of tasks 1-4 implementation; blocker: broken #map nav target'
tags: []
related: [design/caplets_curate/working_module.md, design/landing_page/landing_page_review_findings.md, design/landing_page/skillify_landing_page_review.md, design/landing_page/skillify_landing_page_task_7_review.md, design/landing_page/task_8_responsive_pass.md]
keywords: []
createdAt: '2026-05-28T10:19:04.961Z'
updatedAt: '2026-05-28T10:19:04.961Z'
---
## Reason
Document review findings and blocker for skillify landing page

## Raw Concept
**Task:**
Document spec compliance review for skillify landing page

**Files:**
- docs/plans/2026-05-28-skillify-landing-page.md
- apps/landing/src/pages/index.astro
- apps/landing/src/styles/global.css

**Flow:**
Review -> Identify correct implementations -> Identify blocker -> Report approval status

**Timestamp:** 2026-05-28T10:19:04.960Z

## Narrative
### Structure
Review of tasks 1-4 implementation status and blocker identification

### Dependencies
Requires updated nav target to match trace section

### Highlights
All tasks 1-4 correct except broken navigation target #map

### Examples
Broken link at apps/landing/src/pages/index.astro:165 linking to #map

## Facts
- **apps/landing/src/pages/index.astro**: Task 1 constants are implemented: `heroTrace`, `skillifyFramework`, `trustMechanics`, and `installSteps` match the plan in `apps/landing/src/pages/index.astro:4-140`.
- **apps/landing/src/pages/index.astro**: Generic installs are normalized to `npm install -g caplets` where applicable in `apps/landing/src/pages/index.astro:105`, `114`, `124`, and `136`.
- **apps/landing/src/pages/index.astro**: Task 2 hero is rebuilt around “Skillify your backends.” and the GitHub trace in `apps/landing/src/pages/index.astro:182-236`.
- **apps/landing/src/styles/global.css**: Task 2 trace CSS and updated hero columns are present in `apps/landing/src/styles/global.css:265-269` and `405-556`.
- **apps/landing/src/styles/global.css**: Old map hero CSS selectors requested by Task 2 appear removed from `global.css`.
- **apps/landing/src/pages/index.astro**: Task 3 proof framework is implemented in `apps/landing/src/pages/index.astro:265-279`.
- **apps/landing/src/pages/index.astro**: Task 4 trust mechanics section is implemented in `apps/landing/src/pages/index.astro:281-302`, with CSS in `apps/landing/src/styles/global.css:773-812`.
- **review scope**: Tasks 5+ are not required yet; missing copy buttons, no-JS tab changes, and motion cleanup are not counted as issues for this review scope.
- **global.css**: CSS is located in `apps/landing/src/styles/global.css:773-812`.
- **index.astro**: `apps/landing/src/pages/index.astro:165` still links the primary nav to `href="#map"` and labels it `Map`.
- **index.astro**: Task 2 replaced the old `id="map"` hero visual with `id="trace"` at `apps/landing/src/pages/index.astro:210`.
- **navigation**: The broken in-page navigation target after completing Task 2’s hero replacement needs to be fixed by updating the nav target and label to the new trace section, or restoring a valid `#map` target if intentional.
- **review process**: The reviewer did not run typecheck/build because the request was to inspect diff/current files only.
- **approval**: NOT APPROVED until the broken `#map` navigation target is fixed.
- **#map target**: d `#map` target if intentional.
