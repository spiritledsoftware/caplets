---
"caplets": minor
"@caplets/core": minor
"@caplets/opencode": minor
"@caplets/pi": minor
---

Split Caplets into a pnpm monorepo with a reusable `@caplets/core` runtime package and keep the existing `caplets` CLI package as the published command-line entrypoint.

Add native agent integrations for OpenCode and Pi that expose configured Caplets as prefixed native tools while reusing the same Caplets config and backend execution runtime.
