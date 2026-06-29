---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Vercel
description: Inspect and manage Vercel teams, projects, deployments, logs, and documentation through Vercel's hosted MCP server.
tags:
  - vercel
  - deployments
  - hosting
  - frontend
  - logs
catalog:
  icon: https://assets.vercel.com/image/upload/q_auto/front/favicon/vercel/favicon.ico
mcpServer:
  url: https://mcp.vercel.com
  auth:
    type: oauth2
---

# Vercel

Use this Caplet when an agent needs live Vercel context for teams, projects, deployments, deployment logs, domains, environment configuration, or Vercel documentation.

## First Workflow

1. Start by identifying the Vercel team, project, deployment, branch, domain, or request ID before searching broadly.
2. Inspect project and deployment state before using logs or docs to explain failures.
3. Use deployment logs and build/runtime evidence to distinguish application errors from Vercel platform or configuration issues.
4. Confirm the target team and project before changing domains, environment variables, deployment settings, or aliases.

## Operate Carefully

- Vercel changes can affect production traffic, secrets, previews, and custom domains. Prefer read-only inspection before writes.
- Treat environment variables and build logs as sensitive; summarize the relevant signal without exposing secret values.
- Avoid this Caplet when the task only needs local Next.js, frontend, or repo configuration analysis.
