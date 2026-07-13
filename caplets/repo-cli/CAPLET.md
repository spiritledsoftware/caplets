---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Repository CLI
description: Inspect and run common local repository workflows through curated CLI tools.
tags:
  - cli
  - code
catalog:
  icon: https://git-scm.com/images/logos/downloads/Git-Icon-1788C.png
projectBinding:
  required: true
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

## Prerequisites

Repository CLI requires Project Binding. Every command runs from the bound repository root so that an unrelated working directory cannot become the target project.

The bound environment must provide Git and pnpm. The repository must also define the pnpm `test` script used by `package_test`.

## Available commands

- `git_status` reports the concise working-tree status.
- `git_current_branch` prints the current branch name.
- `package_test` runs the repository's pnpm test script with a two-minute timeout.

## Safety boundary

This Caplet exposes only the commands and fixed arguments declared in frontmatter; it is not arbitrary shell access. The Git commands are read-only. The test command may execute repository-defined scripts, so operators should review the bound project's test configuration and account for any services, credentials, or files those tests use.

To add or change a command, update the curated `cliTools.actions` declaration and keep its arguments, timeout, and read-only annotation explicit.

## Troubleshooting

If a command targets the wrong directory, correct the Project Binding rather than adding path arguments. If a command is unavailable, verify the required executable and repository script in the bound environment.
