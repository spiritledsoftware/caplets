---
title: Extracted Project Facts
summary: Compiled project-related factual statements extracted via RLM extraction
tags: []
related: []
keywords: []
createdAt: '2026-05-27T18:02:18.225Z'
updatedAt: '2026-05-27T18:02:18.225Z'
---
## Reason
Curate extracted factual statements from RLM context

## Raw Concept
**Task:**
Document extracted project facts

**Timestamp:** 2026-05-27T18:02:18.221Z

## Narrative
### Structure
Aggregated factual statements

### Highlights
pnpm alchemy:dev failure, package.json script, alchemy.run.ts content, Astro helper defaults, command execution

## Facts
- **pnpm alchemy:dev failure**: `pnpm alchemy:dev` fails because Alchemy runs Astro from the repository root, but Astro is only installed in the landing workspace.
- **package.json script**: The root script in `package.json` defines "alchemy:dev": "alchemy dev".
- **alchemy.run.ts content**: `alchemy.run.ts` currently contains `export const landing = await Astro("landing", { assets: "apps/landing/dist" });`.
- **Astro helper defaults**: Alchemy’s `Astro()` helper defaults `cwd` to `props.cwd ?? process.cwd()` and `dev` to "pnpm exec astro dev".
- **command execution**: From the repository root, Alchemy effectively runs `pnpm exec astro dev`.
- **error message**: Running `pnpm exec astro dev` from the root fails with error "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command \"astro\" not found".
- **astro dependency location**: `astro` is not a root dependency; it is defined in `apps/landing/package.json`.
- **workspace name**: The workspace package name is "@caplets/landing", not "@landing".
- **workspace command**: The direct workspace command `pnpm --filter @caplets/landing dev` works.
- **root cause**: Root cause: `alchemy.run.ts` does not set `cwd: "apps/landing"` for the Astro resource, causing Alchemy to run Astro in the wrong package context.
- **proposed fix**: A likely fix is to modify `alchemy.run.ts` to include `cwd: "apps/landing"` and adjust assets path, e.g., `export const landing = await Astro("landing", { cwd: "apps/landing", assets: "dist" });`.
