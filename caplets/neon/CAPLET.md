---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Neon
description: Inspect and manage Neon Postgres organizations, projects, branches, databases, roles, queries, and docs through Neon's hosted MCP server.
tags:
  - neon
  - postgres
  - database
  - branches
  - sql
catalog:
  icon: https://neon.com/apple-touch-icon.png
mcpServer:
  url: https://mcp.neon.tech/mcp
  auth:
    type: oauth2
---

# Neon

## Project and Query Scope

Establish the Neon organization, project, branch, database, and role before inspecting state. Branch, schema, migration, and query context should be reviewed before SQL or project changes.

After installation, the MCP URL can be scoped with `projectId`, `readonly=true`, or `category` query parameters. Read-only analysis is appropriate for query tuning, schema review, and branch discovery.

## Safe Operation

- Neon recommends MCP usage for development and testing. Production databases or PII-bearing projects should be connected only after the operator explicitly accepts the risk.
- SQL and branch operations can alter data, credentials, costs, or application behavior. The target branch, database, role, SQL, and expected data effect require confirmation before mutation.
- Connection strings and role credentials must not appear in summaries.
