---
# yaml-language-server: $schema=https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: Context7 Documentation
description: Fetch current library and framework documentation through Context7 before using version-sensitive APIs.
tags:
  - docs
  - libraries
  - frameworks
  - api-reference
setup:
  commands:
    - label: Install Context7 MCP
      command: npm
      args: ["install", "-g", "@upstash/context7-mcp"]
      timeoutMs: 120000
      maxOutputBytes: 200000
  verify:
    - label: Check Context7 MCP
      command: context7-mcp
      args: ["--help"]
      timeoutMs: 10000
      maxOutputBytes: 20000
mcpServer:
  command: context7-mcp
---

# Context7 Documentation

Use this Caplet when the agent needs up-to-date library, SDK, framework, CLI, or cloud-service
documentation before writing code or giving technical instructions.

## Good Fits

- Check current API signatures for fast-moving JavaScript, TypeScript, Python, or cloud libraries.
- Look up migration notes before changing framework configuration.
- Retrieve official examples for a specific package version.
- Resolve uncertainty about CLI flags, config files, or SDK initialization.

## Use Carefully

- Prefer primary documentation over snippets when implementation risk is high.
- Record the library or package name clearly before searching.
- Do not use this as a substitute for project-local types and tests.

## Setup

This Caplet installs `@upstash/context7-mcp` globally with npm, then verifies the installed
`context7-mcp` binary with `--help`. Setup is explicit so hosted and local stdio runtimes start a
known binary without running `npx` package downloads on every agent session.
