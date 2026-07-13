---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Context7
description: Fetch current library and framework documentation through Context7 before using version-sensitive APIs.
avoidWhen: Do not substitute documentation lookup for available local source, lockfiles, generated types, or failing tests.
tags:
  - docs
  - libraries
  - frameworks
  - api-reference
catalog:
  icon: https://context7.com/favicon.ico
mcpServer:
  url: https://mcp.context7.com/mcp/oauth
  auth:
    type: oauth2
---

# Context7

## Documentation Lookup

- Results are most precise when the package, framework, SDK, service, and relevant version are identified.
- A known API symbol supports a narrower lookup than a broad documentation search.
- Current API, configuration, migration, and example material should be checked against the project's local versions, types, and tests.

## Source Quality

- Prefer primary documentation and version-specific examples over generic snippets when implementation risk is high.
- Keep citations or summaries limited to the details that support the implementation decision.
