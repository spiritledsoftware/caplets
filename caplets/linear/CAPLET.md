---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Linear
description: Plan and track product work in Linear by reading teams, projects, cycles, issues, comments, and workflow state.
tags:
  - planning
  - linear
  - issues
  - projects
  - triage
catalog:
  icon: https://linear.app/favicon.ico
mcpServer:
  url: https://mcp.linear.app/mcp
  auth:
    type: oauth2
---

# Linear

## Lookup and Updates

Narrow lookups by issue ID, team key, project, cycle, label, or assignee avoid noisy results. Before an update, review the current issue, linked project, comments, and workflow state. Issue breakdowns and status comments should reflect concrete implementation evidence, and the target issue and intended team-visible effect should be confirmed before writing.

## Reference

- [Workflows](./workflows.md): lookup, planning, status update, and triage documentation.

## Safe Operation

- Linear issue updates are visible to teammates. Read the current state before writing deliberately.
- Concise issue titles and comments are easier to follow; detailed implementation artifacts can remain linked.
- Prefer a team key, issue ID, project, or label over a broad search when one is available.
