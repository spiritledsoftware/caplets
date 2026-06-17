---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: GitHub
description: Inspect and manage GitHub repositories, issues, pull requests, branches, commits, and code review workflows.
tags:
  - code
  - github
  - pull-requests
  - issues
  - reviews
mcpServer:
  transport: http
  url: https://api.githubcopilot.com/mcp
  auth:
    type: bearer
    token: $env:GH_TOKEN
---

# GitHub

Use this Caplet when the agent needs live GitHub repository context or needs to act on
issues, pull requests, branches, commits, or review feedback.

## Good Fits

- Summarize recent pull request activity before a code review.
- Inspect open issues and identify implementation work.
- Create or update issues from an implementation plan.
- Compare branches, inspect commits, or review pull request files.
- Leave review comments after the agent has inspected the relevant diff.

## Use Carefully

- Mutating operations can affect real repositories. Prefer read operations first.
- Use a least-privilege `GH_TOKEN`.
- Do not ask the agent to expose token values, repository secrets, or private issue contents outside
  the intended conversation.

## Setup

Create a GitHub token with the minimum repository scopes needed for your workflow, then export it
before starting Caplets:

```sh
export GH_TOKEN=github_pat_...
caplets serve
```

This Caplet uses GitHub's hosted MCP endpoint at `https://api.githubcopilot.com/mcp`.
