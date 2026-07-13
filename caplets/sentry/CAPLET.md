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

## Investigation scope

Identify the organization, project, environment, release, issue, trace, and time window that bound the investigation. Narrow targets reduce noise and limit exposure of event data.

## Evidence and diagnosis

Inspect issue frequency, recent events, stack traces, tags, breadcrumbs, and suspect commits before deciding on a fix. When a regression is suspected, correlate new errors with deployments or releases. Retain only the smallest evidence set needed for code changes or incident triage.

## Safe operation

Sentry events can contain user, request, and environment details. Keep project and time-window access narrow, and summarize relevant debugging signals without reproducing unnecessary sensitive data. Review mutating operations and their target state before applying changes in Sentry.
