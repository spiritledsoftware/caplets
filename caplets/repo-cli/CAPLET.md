---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Repository CLI
description: Inspect and run common local repository workflows through curated CLI tools.
tags:
  - cli
  - code
cliTools:
  actions:
    git_status:
      description: Show concise Git working tree status.
      command: git
      args:
        - status
        - --short
      annotations:
        readOnlyHint: true
    git_current_branch:
      description: Print the current Git branch name.
      command: git
      args:
        - branch
        - --show-current
      annotations:
        readOnlyHint: true
    package_test:
      description: Run the repository test script with pnpm.
      command: pnpm
      args:
        - run
        - test
      timeoutMs: 120000
---

# Repository CLI

Use this Caplet to expose a small, typed set of local repository commands without giving an agent arbitrary shell access.
