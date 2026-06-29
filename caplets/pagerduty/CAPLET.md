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

Use this Caplet when an agent needs PagerDuty incident, service, schedule, escalation policy, event orchestration, on-call, or operational response context.

## First Workflow

1. Start by confirming the PagerDuty account, API host, incident ID, service, team, schedule, escalation policy, user, or time window.
2. Inspect current incident state, responders, escalation policy, timeline, notes, alerts, and related service context before taking action.
3. Use schedule and on-call lookups before proposing handoffs, overrides, or escalation changes.
4. Summarize the target incident, service, user, schedule, and expected responder effect before mutating anything.

## Operate Carefully

- PagerDuty changes can page people, alter incident response, affect escalation, or change operational accountability. Prefer read-only inspection before writes.
- The default catalog entry does not pass the upstream `--enable-write-tools` flag. Add it only when write operations are intentionally needed.
- For EU accounts, update `PAGERDUTY_API_HOST` to the EU API host before starting the server.
- Avoid this Caplet when the task only needs local runbooks or postmortem files.
