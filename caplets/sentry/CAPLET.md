---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Sentry
description: Inspect Sentry issues, events, traces, releases, and AI debugging context through Sentry's hosted MCP server.
tags:
  - observability
  - sentry
  - errors
  - tracing
catalog:
  icon: https://sentry.io/favicon.ico
mcpServer:
  url: https://mcp.sentry.dev/mcp
  auth:
    type: oauth2
---

# Sentry

Use this Caplet when an agent needs live Sentry context while debugging production errors, investigating traces, or checking release health.

## First Workflow

1. Narrow by organization, project, environment, release, issue, trace, or time window before querying.
2. Inspect issue frequency, recent events, stack traces, tags, breadcrumbs, and suspect commits before proposing fixes.
3. Correlate deploys or releases with new errors when a regression is suspected.
4. Bring back the smallest evidence set needed to guide code changes or triage.

## Operate Carefully

Sentry data can contain user, request, and environment details. Ask for narrow projects and time windows, summarize only the needed debugging context, and review any mutating tool calls before applying changes to Sentry state.
