---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: PagerDuty
description: Inspect PagerDuty incidents, services, schedules, escalation policies, event orchestrations, on-call context, and related operational state through PagerDuty's MCP server.
tags:
  - pagerduty
  - incidents
  - on-call
  - services
  - operations
catalog:
  icon: https://www.pagerduty.com/favicon.ico
setup:
  verify:
    - label: Check uvx is available
      command: uvx
      args:
        - --version
mcpServer:
  command: uvx
  args:
    - pagerduty-mcp
  env:
    PAGERDUTY_USER_API_KEY: $vault:PAGERDUTY_USER_API_KEY
    PAGERDUTY_API_HOST: https://api.pagerduty.com
  startupTimeoutMs: 100000
  callTimeoutMs: 300000
---

# PagerDuty

## Operational Scope

Establish the PagerDuty account and API host together with the exact incident ID, service, team, schedule, escalation policy, user, or time window. Current incident state, responders, escalation policy, timeline, notes, alerts, and service context should be inspected before action. Schedule and on-call lookups provide context for handoffs, overrides, or escalation changes.

## Safe Operation and Setup

- PagerDuty changes can page people, alter incident response, affect escalation, or change operational accountability. Read-only inspection should precede writes, and the target incident, service, user, schedule, and expected responder effect require confirmation.
- The default catalog entry does not pass the upstream `--enable-write-tools` flag. Operators should add it only when write operations are intentionally needed.
- EU accounts require `PAGERDUTY_API_HOST` to be set to the EU API host before server startup.
