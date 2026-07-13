---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Vercel
description: Inspect and manage Vercel teams, projects, deployments, logs, and documentation through Vercel's hosted MCP server.
avoidWhen: Use local Next.js, frontend, or repository configuration when no live Vercel context is needed.
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

## Targeting

Identify the Vercel team, project, deployment, branch, domain, or request ID before searching. Confirm the target team and project before changing domains, environment variables, deployment settings, or aliases.

## Investigation

Inspect project and deployment state before consulting logs or documentation. Deployment logs and build or runtime evidence can distinguish application failures from Vercel platform or configuration problems.

## Safe operation

Vercel changes can affect production traffic, previews, secrets, and custom domains. Prefer read-only inspection before writes, and review the production target and expected traffic impact before mutation.

Environment variables and build logs may contain sensitive data. Preserve only the relevant diagnostic signal and do not reproduce secret values.
