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
mcpServer:
  url: https://mcp.linear.app/mcp
  auth:
    type: oauth2
---

# Linear

Use this Caplet when the agent needs live product planning context from Linear or needs to keep
implementation work synchronized with issues, projects, and team workflows.

## Good Fits

- Find the current issue or project that matches a requested feature.
- Summarize open work by team, project, cycle, label, or assignee.
- Draft issue breakdowns from a technical plan.
- Add implementation notes or status comments after code changes.
- Check whether a bug or feature already has active work before creating a new issue.

## Reference Files

- [Workflows](./workflows.md): recommended lookup, planning, status update, and triage flows.

## Use Carefully

- Linear issue updates are visible to teammates. Read first, then write deliberately.
- Keep issue titles and comments concise; use links to detailed implementation artifacts when useful.
- Avoid broad, noisy searches when a team key, issue ID, project, or label is available.
