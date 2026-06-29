---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Azure
description: Inspect and manage Azure resources, subscriptions, services, deployment state, and documentation through Microsoft's Azure MCP Server.
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

Use this Caplet when an agent needs live Azure subscription, resource group, service, deployment, monitoring, storage, database, identity, or documentation context through Microsoft's Azure MCP Server.

## First Workflow

1. Start by confirming the Azure tenant, subscription, resource group, Region, service namespace, and resource name before querying broadly.
2. Use list, get, documentation, and diagnostic operations to narrow resource state before changing anything.
3. Inspect dependencies, tags, identities, access controls, costs, deployment history, and monitoring evidence before proposing operational changes.
4. Summarize the tenant, subscription, resource group, resource, and expected production effect before mutating resources.

## Operate Carefully

- Azure operations can affect production infrastructure, data, identity boundaries, billing, and compliance posture. Prefer read-only inspection before writes.
- Authenticate with least-privilege Azure roles and the intended tenant before starting the server.
- Confirm destructive or high-impact targets before deleting, scaling, redeploying, rotating credentials, changing RBAC, modifying networking, or changing data stores.
- Avoid this Caplet when the task only needs local IaC or application files.
