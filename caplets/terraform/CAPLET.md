---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Terraform
description: Inspect Terraform Registry providers, modules, policies, and optional HCP Terraform or Terraform Enterprise workspaces through HashiCorp's MCP server.
avoidWhen: Edit local Terraform files directly when no external provider, module, policy, or workspace context is needed.
tags:
  - terraform
  - infrastructure
  - iac
  - registry
  - hcp
catalog:
  icon: https://developer.hashicorp.com/favicon.ico
setup:
  verify:
    - label: Check Docker is available
      command: docker
      args:
        - --version
mcpServer:
  command: docker
  args:
    - run
    - -i
    - --rm
    - hashicorp/terraform-mcp-server:1.0.0
  runtime:
    features:
      - docker
  startupTimeoutMs: 100000
  callTimeoutMs: 300000
---

# Terraform

## Prerequisites

Docker must be available for the catalog runtime. Before relying on results, confirm the Terraform version, provider or module source, workspace, organization, and backend assumptions.

The default catalog entry starts the public Registry-capable Docker server without checked-in HCP Terraform credentials. HCP Terraform or Terraform Enterprise access requires the runtime to be configured with the intended address and a least-privilege token scoped to the required organization or workspace.

## Registry and workspace use

Begin with read-only Registry lookups for provider, module, resource, data source, and policy documentation. Treat generated Terraform recommendations and plans as review material rather than approved changes.

## Safe operation

Terraform changes can affect infrastructure, cost, data access, security, and compliance. Review recommendations and plans against project policy and the exact workspace before implementation or apply.
