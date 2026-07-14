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

## Targeting and Prerequisites

- Confirm the intended account, Region, profile, service, and resource identifiers before inspecting broad AWS state.
- Documentation, skill, list, and describe operations can narrow ambiguous service behavior or resource matches.
- For multi-account installations, named profiles are exposed through `AWS_MCP_PROXY_PROFILES`; select the intended profile on calls that support it.
- Use explicit Region names when the target Region matters, especially when the runtime was not started with `AWS_REGION`.

## Safe Operation

- Inspect existing resource state, IAM context, dependencies, tags, and CloudTrail or service evidence before operational changes.
- AWS operations can affect production infrastructure, data, security boundaries, billing, and compliance posture. Keep access read-only until a write is necessary.
- Use least-privilege IAM roles, permission boundaries, and AWS MCP Server IAM condition keys where available.
- Review the target account, Region, resource, and expected production effect before a mutation.
- Confirm destructive or high-impact targets before deleting, replacing, scaling, deploying, rotating credentials, changing IAM, modifying network policy, or changing data stores.

## Troubleshooting

If credentials are missing or expired, refresh the AWS CLI credentials and rerun the setup verification before retrying.
