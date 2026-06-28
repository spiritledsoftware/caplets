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

Use this Caplet when the agent needs live product planning context from Linear or needs to keep implementation work synchronized with issues, projects, and team workflows.

## First Workflow

1. Search by issue ID, team key, project, cycle, label, or assignee before using broad queries.
2. Read the current issue, linked project, comments, and workflow state before planning or updating.
3. Draft issue breakdowns or status comments from concrete implementation evidence.
4. Write updates only after confirming the target issue and the intended team-visible effect.

## Reference Files

- [Workflows](./workflows.md): recommended lookup, planning, status update, and triage flows.

## Operate Carefully

- Linear issue updates are visible to teammates. Read first, then write deliberately.
- Keep issue titles and comments concise; use links to detailed implementation artifacts when useful.
- Avoid broad, noisy searches when a team key, issue ID, project, or label is available.
