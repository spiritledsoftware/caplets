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

## Bundle Contents

The set combines repository and code-intelligence capabilities with package, vulnerability, documentation, and browser tooling. Child availability depends on installation scope, setup state, and Project Binding state; not every child is necessarily available at runtime.

## Setup and Safety

- Some child Caplets require Project Binding, additional setup, or awareness of local-control risks.
- Operators should review a child's own README and frontmatter before enabling project-bound or high-risk capabilities.
- Browser children can interact with rendered or live web contexts and should be enabled only with the control surface appropriate to the installation.
