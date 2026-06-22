# Caplets Docs

Astro Starlight documentation site for [docs.caplets.dev](https://docs.caplets.dev).

Public docs live in `apps/docs/src/content/docs`. Root `docs/` is internal maintainer
documentation and is not routed into this site.

Generated reference pages come from:

- `schemas/caplets-config.schema.json`
- `schemas/caplet.schema.json`
- `packages/core/src/code-mode/runtime-api.d.ts`

## Commands

Run from the repository root:

```sh
pnpm docs:generate
pnpm docs:check
pnpm --filter @caplets/docs dev -- --port 4322
pnpm --filter @caplets/docs typecheck
pnpm --filter @caplets/docs build
```
