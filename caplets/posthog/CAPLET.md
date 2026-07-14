---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: PostHog
description: Inspect PostHog analytics, feature flags, experiments, session replay, and product telemetry through PostHog's hosted MCP server.
tags:
  - analytics
  - posthog
  - product
  - feature-flags
catalog:
  icon: https://posthog.com/icons/icon-192x192.png
mcpServer:
  url: https://mcp.posthog.com/mcp
  auth:
    type: oauth2
---

# PostHog

## Analysis Scope

A concrete product question, feature flag, experiment, event, or time window keeps analysis bounded. Trends, funnels, retention, and HogQL results provide evidence before conclusions are drawn. Feature flags, experiments, and rollout state should be inspected before dependent code changes. Session replay and event details should be limited to the debugging context needed.

## Safe Operation

PostHog MCP includes mutating tools for flags, insights, dashboards, and other project state. Read-only inspection should precede mutation, planned changes should be reviewed, and OAuth access should remain scoped to the intended PostHog organization and project.
