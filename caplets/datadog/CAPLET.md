---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Datadog
description: Query Datadog logs, metrics, traces, dashboards, monitors, incidents, services, events, notebooks, and observability insights through Datadog's managed MCP server.
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

Use this Caplet when an agent needs live Datadog observability context for logs, metrics, traces, monitors, dashboards, incidents, hosts, services, events, notebooks, APM, or agent observability.

## First Workflow

1. Start by confirming the Datadog site, organization, service, environment, time window, tags, monitor, incident, trace ID, or dashboard target.
2. Query narrow time ranges and tags first, then widen only when the first pass misses relevant evidence.
3. Correlate logs, metrics, traces, deployment events, monitor status, and incidents before naming a cause.
4. Add a `toolsets` query parameter after install when the workflow should expose only specific Datadog product areas.

## Operate Carefully

- Datadog evidence can include production telemetry, customer identifiers, incident details, and security signals. Summarize the signal without leaking sensitive payloads.
- Confirm the Datadog site and endpoint host for non-US1 organizations before authenticating.
- Prefer read-only investigation before changing monitors, dashboards, notebooks, incident state, or platform configuration.
- Avoid this Caplet when the task only needs local log files or application instrumentation code.
