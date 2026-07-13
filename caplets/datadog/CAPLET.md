---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Datadog
description: Query Datadog logs, metrics, traces, dashboards, monitors, incidents, services, events, notebooks, and observability insights through Datadog's managed MCP server.
avoidWhen: Prefer local tools when only local log files or application instrumentation code are needed.
tags:
  - datadog
  - observability
  - logs
  - metrics
  - incidents
catalog:
  icon: https://www.datadoghq.com/favicon.ico
mcpServer:
  url: https://mcp.datadoghq.com/api/unstable/mcp-server/mcp
  auth:
    type: oauth2
  startupTimeoutMs: 100000
  callTimeoutMs: 300000
---

# Datadog

## Targeting and Setup

- Confirm the Datadog site, organization, service, environment, time window, tags, monitor, incident, trace ID, or dashboard target.
- For non-US1 organizations, confirm the Datadog site and endpoint host before authentication.
- The `toolsets` query parameter can be added after installation to expose only the required Datadog product areas.

## Investigation and Safety

- Begin with narrow time ranges and tags, widening only when the first pass misses relevant evidence.
- Logs, metrics, traces, deployment events, monitor status, and incidents provide complementary evidence and should be correlated before a cause is assigned.
- Production telemetry can include customer identifiers, incident details, and security signals. Summaries should omit sensitive payloads.
- Keep investigation read-only until changes to monitors, dashboards, notebooks, incident state, or platform configuration are necessary.
