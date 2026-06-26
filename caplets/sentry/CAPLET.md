---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Sentry
description: Inspect Sentry issues, events, traces, releases, and AI debugging context through Sentry's hosted MCP server.
tags:
  - observability
  - sentry
  - errors
  - tracing
mcpServer:
  transport: http
  url: https://mcp.sentry.dev/mcp
  auth:
    type: oauth2
---

# Sentry

Use this Caplet when an agent needs live Sentry context while debugging production errors, investigating traces, or checking release health.

## Good Fits

- Find the highest-impact issues for a project and time range.
- Inspect event details, stack traces, tags, breadcrumbs, and suspect commits.
- Correlate deploys or releases with new errors before changing code.

## Use Carefully

Sentry data can contain user, request, and environment details. Ask for narrow projects and time windows, summarize only the needed debugging context, and review any mutating tool calls before applying changes to Sentry state.
