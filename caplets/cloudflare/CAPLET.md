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

## Targeting and Prerequisites

- Use the account ID, zone ID, domain, Worker name, rule ID, or another exact resource identifier when available.
- List and get operations can narrow ambiguous matches before any create, update, delete, purge, or deployment.
- OAuth access should be limited to the intended Cloudflare account and resources.

## Safe Operation

- Read current resource state before a change, especially for DNS records, security rules, Workers routes, cache settings, and access policies.
- Cloudflare changes can affect production traffic, DNS resolution, security policy, cache behavior, and deployed code. Keep access read-only until a write is necessary.
- Review the target resource and intended external effect before a mutation.
- Confirm destructive targets before deleting DNS records, rules, routes, keys, certificates, applications, Workers resources, or account-level settings.
