---
$schema: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: GitHub CLI
description: Inspect GitHub pull requests and issues through curated gh CLI commands.
tags:
  - cli
  - github
  - code
cliTools:
  actions:
    gh_pr_status:
      description: Show pull request status for the current branch as JSON.
      command: gh
      args:
        - pr
        - status
        - --json
        - currentBranch
      output:
        type: json
      annotations:
        readOnlyHint: true
        openWorldHint: true
    gh_issue_list:
      description: List open GitHub issues as JSON.
      command: gh
      args:
        - issue
        - list
        - --json
        - number,title,state,url
      output:
        type: json
      annotations:
        readOnlyHint: true
        openWorldHint: true
---

# GitHub CLI

Use this Caplet to expose read-oriented GitHub workflows through `gh` without giving the agent an unrestricted shell.
