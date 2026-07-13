---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Supabase
description: Inspect and manage Supabase projects, databases, schemas, branches, storage, edge functions, and docs through Supabase's hosted MCP server.
avoidWhen: Use local migration files or application code when live Supabase state is not needed.
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

## Prerequisites and scope

Confirm the Supabase organization, project reference, branch, and environment before accessing project state. After installation, the `project_ref` query parameter can scope access to a specific project. For investigation-only access, configure `read_only=true` or feature-group filtering on the MCP URL.

## Safe operation

Inspect schemas, tables, policies, migrations, functions, and storage buckets before making changes. Review intended SQL, RLS policy effects, generated migrations, storage operations, function changes, and branch targets before execution.

Supabase recommends MCP access primarily for development and testing. Connect a production project only after the operator has explicitly accepted the risk. Database and authentication policy changes can expose data or break applications.

## Sensitive data

Keep PII and secrets out of captured prompts and logs. Use narrow project, feature, and read-only scopes to reduce unnecessary data exposure.
