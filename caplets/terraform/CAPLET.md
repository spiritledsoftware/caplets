---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Terraform
description: Inspect Terraform Registry providers, modules, policies, and optional HCP Terraform or Terraform Enterprise workspaces through HashiCorp's MCP server.
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

Use this Caplet when an agent needs Terraform Registry context for providers, modules, policies, or HCP Terraform and Terraform Enterprise workspace context exposed to the server.

## First Workflow

1. Start with read-only Registry lookups for provider, module, resource, data source, and policy documentation.
2. Confirm Terraform version, provider source, module source, workspace, organization, and backend assumptions before proposing changes.
3. Use HCP Terraform or Terraform Enterprise operations only when the server runtime has been configured with the intended token and address.
4. Review generated Terraform recommendations against project policy, security, cost, and compliance requirements before implementation.

## Operate Carefully

- Terraform recommendations can affect infrastructure, cost, data access, and compliance once applied. Treat generated plans as suggestions until reviewed against the project.
- HCP Terraform and Terraform Enterprise tokens should be least-privilege and scoped to the intended organization or workspace.
- The default catalog entry starts the public Registry-capable Docker server without checked-in HCP credentials.
- Avoid this Caplet when the task only needs to edit local Terraform files without external provider, module, or workspace context.
