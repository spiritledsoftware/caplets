---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: AWS
description: Inspect and manage AWS accounts, Regions, services, resources, IAM-authorized operations, and AWS documentation through the managed AWS MCP Server.
tags:
  - aws
  - cloud
  - infrastructure
  - iam
  - operations
catalog:
  icon: https://a0.awsstatic.com/libra-css/images/site/fav/favicon.ico
setup:
  verify:
    - label: Check AWS CLI identity
      command: aws
      args:
        - sts
        - get-caller-identity
    - label: Check uvx is available
      command: uvx
      args:
        - --version
mcpServer:
  command: uvx
  args:
    - mcp-proxy-for-aws==1.6.2
    - https://aws-mcp.us-east-1.api.aws/mcp
  startupTimeoutMs: 100000
  callTimeoutMs: 300000
---

# AWS

Use this Caplet when an agent needs live AWS account, Region, service, resource, IAM, operational, or AWS documentation context through the managed AWS MCP Server.

## First Workflow

1. Start by confirming the intended account, Region, profile, service, and resource identifiers before querying broad AWS state.
2. Use documentation, skill, list, and describe operations to narrow ambiguous service behavior or resource matches before changing anything.
3. Inspect existing resource state, IAM context, dependencies, tags, and CloudTrail or service evidence before proposing operational changes.
4. For multi-account work, prefer named AWS profiles exposed through `AWS_MCP_PROXY_PROFILES`, and pass the intended profile on calls that support profile selection.
5. Use explicit Region names in requests when the target Region matters, especially if the runtime was not started with `AWS_REGION`.
6. Summarize the target account, Region, resource, and expected production effect before mutating resources.

## Operate Carefully

- AWS operations can affect production infrastructure, data, security boundaries, billing, and compliance posture. Prefer read-only inspection before writes.
- Use least-privilege IAM roles, permission boundaries, and AWS MCP Server IAM condition keys where available.
- Confirm destructive or high-impact targets before deleting, replacing, scaling, deploying, rotating credentials, changing IAM, modifying network policy, or changing data stores.
- If credentials are missing or expired, refresh AWS CLI credentials and rerun the setup verification before retrying.
- Avoid this Caplet when the task only needs local IaC or application files; use the project workspace and deployment tooling for local configuration state.
