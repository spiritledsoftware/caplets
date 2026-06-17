---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Coding Agent Toolkit
description: self-contained nested toolkit of high-value Caplets for coding agents.
tags:
  - coding-agent
  - toolkit
  - caplets
capletSet:
  capletsRoot: ./caplets
---

# Coding Agent Toolkit

Use this CapletSet to give coding agents a focused bundle of high-value Caplets for repository inspection, code search, package metadata, vulnerability lookup, hosted documentation, and browser automation.

The source repository keeps the child Caplets in this toolkit as symlinks to the canonical top-level examples. That avoids duplicate maintenance while keeping one curated toolkit entry point.

When a directory Caplet is installed, Caplets materializes those symlinked children as real files and directories. Installed copies are self-contained and do not depend on the source repository symlink layout.
