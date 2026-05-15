---
"caplets": patch
"@caplets/core": patch
"@caplets/opencode": patch
---

Fix monorepo package entrypoints so the CLI resolves MCP SDK subpaths on Node ESM, reports the CLI package version, and the OpenCode plugin exposes only its default plugin export.
