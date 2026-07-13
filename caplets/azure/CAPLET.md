---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Azure
description: Inspect and manage Azure resources, subscriptions, services, deployment state, and documentation through Microsoft's Azure MCP Server.
avoidWhen: Prefer the project workspace when only local IaC or application files are needed.
tags:
  - azure
  - cloud
  - infrastructure
  - microsoft
  - operations
catalog:
  icon: https://azure.microsoft.com/favicon.ico
setup:
  verify:
    - label: Check Azure CLI account
      command: az
      args:
        - account
        - show
    - label: Check npx is available
      command: npx
      args:
        - --version
mcpServer:
  command: npx
  args:
    - -y
    - "@azure/mcp@latest"
    - server
    - start
  startupTimeoutMs: 100000
  callTimeoutMs: 300000
---

# Azure

## Targeting and Prerequisites

- Confirm the intended tenant, subscription, resource group, Region, service namespace, and resource name before inspecting broad Azure state.
- Authenticate against the intended tenant with least-privilege Azure roles before starting the server.
- List, get, documentation, and diagnostic operations can narrow ambiguous resource matches.

## Safe Operation

- Inspect dependencies, tags, identities, access controls, costs, deployment history, and monitoring evidence before operational changes.
- Azure operations can affect production infrastructure, data, identity boundaries, billing, and compliance posture. Keep access read-only until a write is necessary.
- Review the tenant, subscription, resource group, resource, and expected production effect before a mutation.
- Confirm destructive or high-impact targets before deleting, scaling, redeploying, rotating credentials, changing RBAC, modifying networking, or changing data stores.
