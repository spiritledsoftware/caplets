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

## Targeting remote work

Identify the repository and the relevant issue, pull request, branch, or commit before taking action. Narrow lookups by repository, PR number, issue number, branch, label, or author whenever possible. Review work should include the changed files and relevant discussion; issue drafts and updates should stay concise and grounded in current implementation evidence.

## Safe operation

- GitHub mutations affect real repositories. Read current remote state before writing.
- Confirm the target repository, branch, issue, or pull request before creating comments, labels, branches, or updates.
- Keep token values, repository secrets, and private issue contents within their intended access boundary.
