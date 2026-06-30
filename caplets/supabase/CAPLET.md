---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Supabase
description: Inspect and manage Supabase projects, databases, schemas, branches, storage, edge functions, and docs through Supabase's hosted MCP server.
tags:
  - supabase
  - postgres
  - database
  - backend
  - storage
catalog:
  icon: https://supabase.com/favicon/favicon-32x32.png
mcpServer:
  url: https://mcp.supabase.com/mcp
  auth:
    type: oauth2
---

# Supabase

Use this Caplet when an agent needs Supabase project, database, schema, branch, storage, edge function, auth, or documentation context.

## First Workflow

1. Start by confirming the Supabase organization, project reference, branch, and environment before querying project state.
2. Prefer read-only discovery of schemas, tables, policies, migrations, functions, and storage buckets before making changes.
3. Scope high-risk work to a specific project with the `project_ref` query parameter after install when possible.
4. Use `read_only=true` or feature-group filtering on the MCP URL for investigation-only workflows.
5. Summarize intended SQL, policy, migration, storage, or function changes before executing them.

## Operate Carefully

- Supabase's own guidance treats MCP access as best suited for development and testing. Do not connect production projects unless the operator has explicitly accepted the risk.
- Database and auth policy changes can expose data or break applications. Review SQL, RLS policy effects, generated migrations, and branch targets carefully.
- Avoid handling PII or secrets through agent-visible prompts and logs.
- Avoid this Caplet when the task only needs local migration files or application code without live Supabase state.
