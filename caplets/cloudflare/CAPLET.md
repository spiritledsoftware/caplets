---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Cloudflare
description: Inspect and manage Cloudflare accounts, zones, DNS, Workers, security settings, caches, rules, and other resources through Cloudflare's hosted MCP server.
tags:
  - cloudflare
  - dns
  - workers
  - security
  - infrastructure
catalog:
  icon: https://www.cloudflare.com/favicon.ico
mcpServer:
  url: https://mcp.cloudflare.com/mcp
  auth:
    type: oauth2
---

# Cloudflare

Use this Caplet when an agent needs live Cloudflare account or zone context, or needs to act on DNS, Workers, cache, rules, security, access, pages, images, logs, or other Cloudflare resources through Cloudflare's hosted MCP server.

## First Workflow

1. Start with the account ID, zone ID, domain, Worker name, rule ID, or other exact resource identifier when available.
2. Read current resource state before proposing or applying changes, especially for DNS records, security rules, Workers routes, cache settings, and access policies.
3. Use list and get operations to narrow ambiguous matches before creating, updating, deleting, purging, or deploying anything.
4. Summarize the intended external effect and target resource before making mutating calls.

## Operate Carefully

- Cloudflare changes can affect production traffic, DNS resolution, security policy, cache behavior, and deployed code. Prefer read-only inspection first.
- Keep OAuth access limited to the Cloudflare account and resources intended for the task.
- Confirm destructive targets before deleting DNS records, rules, routes, keys, certificates, applications, Workers resources, or account-level settings.
- Avoid this Caplet when the task only needs local Cloudflare project files; use the project workspace and Cloudflare tooling for local configuration state.
