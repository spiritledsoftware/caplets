---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Coding Agent Toolkit
description: self-contained nested toolkit of high-value Caplets for coding agents.
tags:
  - coding-agent
  - toolkit
  - caplets
catalog:
  icon: https://caplets.dev/icon.png
capletSet:
  capletsRoot: ./caplets
---

# Coding Agent Toolkit

Use this CapletSet when the agent needs a compact default toolkit for coding work rather than a large bespoke integration list.

## First Workflow

1. Use repository and code-intelligence Caplets for local facts before making implementation claims.
2. Use package, vulnerability, and documentation Caplets to verify external dependency assumptions.
3. Use browser automation only when rendered behavior or live web context is part of the task.

## Operate Carefully

- This set is a convenience bundle; prefer a narrower individual Caplet when the user asks for a specific provider or capability.
- Some child Caplets require Project Binding, setup, or local-control awareness. Inspect the child Caplet before using high-risk or project-bound capabilities.
- Do not assume every child is available at runtime; availability depends on installation scope, setup state, and binding state.
