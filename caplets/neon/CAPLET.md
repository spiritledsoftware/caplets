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
  icon: https://neon.com/favicon.ico
mcpServer:
  url: https://mcp.neon.tech/mcp
  auth:
    type: oauth2
---

# Neon

Use this Caplet when an agent needs live Neon Postgres context for projects, branches, databases, roles, SQL queries, connection details, or Neon documentation.

## First Workflow

1. Start by confirming the Neon organization, project, branch, database, and role before querying state.
2. Inspect branch, schema, migration, and query context before suggesting SQL or project changes.
3. Scope the MCP URL after install with `projectId`, `readonly=true`, or `category` query parameters when the task has a narrow target.
4. Use read-only analysis for query tuning, schema review, and branch discovery before executing SQL.
5. Summarize the target branch, database, role, SQL, and expected data effect before mutating anything.

## Operate Carefully

- Neon recommends MCP usage for development and testing. Do not connect production databases or PII-bearing projects unless the operator has explicitly accepted that risk.
- SQL and branch operations can alter data, credentials, costs, or application behavior. Confirm exact targets before writes.
- Keep connection strings and role credentials out of summaries.
- Avoid this Caplet when the task only needs local migration files, ORMs, or application code.
