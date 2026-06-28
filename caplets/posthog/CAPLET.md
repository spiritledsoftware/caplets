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

Use this Caplet when an agent needs product analytics or feature-flag context from PostHog before planning, debugging, or validating a change.

## First Workflow

1. Start from a concrete product question, feature flag, experiment, event, or time window.
2. Read trends, funnels, retention, or HogQL results before drawing conclusions.
3. Inspect feature flags, experiments, and rollout state before changing code that depends on them.
4. Use session replay or event details only for the minimal debugging context needed.

## Operate Carefully

PostHog MCP includes mutating tools for flags, insights, dashboards, and other project state. Prefer read-only inspection first, review planned mutations, and keep OAuth access scoped to the PostHog organization and project you intend to expose.
