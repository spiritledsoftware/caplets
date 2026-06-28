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
catalog:
  icon: https://github.githubassets.com/favicons/favicon.svg
mcpServer:
  url: https://api.githubcopilot.com/mcp
  auth:
    type: bearer
    token: $vault:GH_TOKEN
---

# GitHub

Use this Caplet when the agent needs live GitHub repository context or needs to act on issues, pull requests, branches, commits, or review feedback.

## First Workflow

1. Read the relevant repository, issue, pull request, branch, or commit before taking action.
2. Narrow by repo, PR number, issue number, branch, label, or author whenever possible.
3. For reviews, inspect changed files and relevant discussion before commenting.
4. For issue creation or updates, draft concise content tied to the current implementation evidence.

## Operate Carefully

- Mutating operations can affect real repositories. Prefer read operations first.
- Confirm target repository, branch, issue, or pull request before creating comments, labels, branches, or updates.
- Do not expose token values, repository secrets, or private issue contents outside the intended conversation.
- Prefer local Git and project files for workspace state; use GitHub for remote truth.
