---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: PostHog
description: Inspect PostHog analytics, feature flags, experiments, session replay, and product telemetry through PostHog's hosted MCP server.
tags:
  - analytics
  - posthog
  - product
  - feature-flags
mcpServer:
  transport: http
  url: https://mcp.posthog.com/mcp
  auth:
    type: oauth2
---

# PostHog

Use this Caplet when an agent needs product analytics or feature-flag context from PostHog before planning, debugging, or validating a change.

## Good Fits

- Query trends, funnels, retention, or HogQL for a product question.
- Inspect feature flags, experiments, or rollout state before changing code.
- Search session replays and event data while investigating user-reported behavior.

## Use Carefully

PostHog MCP includes mutating tools for flags, insights, dashboards, and other project state. Prefer read-only inspection first, review planned mutations, and keep OAuth access scoped to the PostHog organization and project you intend to expose.
