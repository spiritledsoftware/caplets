---
title: Caplets Module
summary: Extracted factual statements about caplets implementation and usage
tags: []
related: []
keywords: []
createdAt: '2026-05-27T23:54:41.417Z'
updatedAt: '2026-05-27T23:54:41.417Z'
---
## Reason
Curate extracted facts from caplets source context

## Raw Concept
**Task:**
Document caplets module knowledge

**Timestamp:** 2026-05-27T23:54:41.412Z

## Facts
- **commit_range_0e56e8f..HEAD**: Reviewed committed changes only for `0e56e8f^..HEAD` covering `apps/landing/src/pages/index.astro`, `apps/landing/src/styles/global.css`, and `docs/plans/2026-05-27-agent-card-setup-tabs.md`.
- **file_selection**: Ignored unrelated unstaged/untracked files shown by `git status`.
- **OpenCode**: Previous misinformation blockers are fixed: OpenCode setup now uses native plugin install/config with `npm install -g @caplets/opencode` and plugin configuration in `apps/landing/src/pages/index.astro:51-57` as confirmed by `packages/opencode/README.md`.
- **Pi**: Previous misinformation blockers are fixed: Pi setup now uses Pi extension install/settings with `pi install npm:@caplets/pi` and package registration in `apps/landing/src/pages/index.astro:60-66` as confirmed by `packages/pi/README.md`.
- **tab_interface**: Accessibility implementation uses proper `role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`, `aria-controls`, and `aria-labelledby` at `apps/landing/src/pages/index.astro:260-284`.
- **apps/landing/src/pages/index.astro:260-284**: Uses proper role="tablist", role="tab", role="tabpanel", aria-selected, aria-controls, and aria-labelledby
- **apps/landing/src/pages/index.astro:359-380**: Keyboard navigation supports ArrowLeft/ArrowRight/Home/End and moves focus/selection
- **apps/landing/src/pages/index.astro:284**: Hidden inactive panels use the native hidden attribute
- **apps/landing/src/styles/global.css:993-995**: CSS reinforces display behavior for hidden panels
- **Astro/TypeScript code**: Inline script types are valid
- **pnpm typecheck**: pnpm --filter @caplets/landing typecheck passed with 0 errors/warnings/hints
- **pnpm build**: pnpm --filter @caplets/landing build passed
- **apps/landing/src/styles/global.css:953-1019**: Styling reuses existing design tokens and visual language (--night-*, --font-mono, --ease-out)
- **apps/landing/src/styles/global.css:1256-1258**: Responsive behavior collapses setup grid cleanly
- **apps/landing/src/styles/global.css:1326-1333**: Reduced-motion fallback includes new tab/panel elements
- **apps/landing/src/pages/index.astro:26-78**: agentSetups centralizes tab labels, commands, snippets, and notes
- **apps/landing/src/pages/index.astro:80**: integrations derives from agentSetups, avoiding duplicated client names
- **Project status**: Blocker: None
- **Build warning**: Build emits a Node deprecation warning from tooling (module.register()), but the landing typecheck/build both pass and this is unrelated to the committed tab changes
- **blocker**: Blocker: None.
