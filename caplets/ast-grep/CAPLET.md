---
# yaml-language-server: $schema=https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: ast-grep
description: Search, scan, test, rewrite, and scaffold ast-grep rules through curated MCP tools.
tags:
  - mcp
  - code
  - search
setup:
  commands:
    - label: Install ast-grep MCP
      command: npm
      args: ["install", "-g", "ast-grep-mcp"]
      timeoutMs: 120000
      maxOutputBytes: 200000
  verify:
    - label: Check ast-grep MCP
      command: ast-grep-mcp
      args: ["--help"]
      timeoutMs: 10000
      maxOutputBytes: 20000
mcpServer:
  command: ast-grep-mcp
---

# ast-grep MCP

Use this Caplet to expose ast-grep's structural search, scan, rule testing, rewrite, and scaffold workflows without giving an agent unrestricted shell access.

The manifest uses the full `ast-grep-mcp` MCP server.

## Setup

This Caplet installs `ast-grep-mcp` globally with npm, then verifies the installed binary with
`ast-grep-mcp --help`. Setup is explicit because hosted and local stdio runtimes need a stable
binary instead of running package-manager downloads during each MCP startup.

## Safety

Read-only search, scan, and normal test actions set `readOnlyHint: true`. Apply-all rewrite, snapshot-update, and scaffolding actions set `destructiveHint: true` because they can modify files.
