---
title: MCP resource templates should be optional in health checks
date: 2026-06-24
category: docs/solutions/integration-issues
module: MCP backend health checks
problem_type: integration_issue
component: tooling
symptoms:
  - PostHog check-backend reported unavailable with MCP error -32601 Method not found
  - Tools and resources still listed successfully for the same backend
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [mcp, healthcheck, resource-templates, posthog]
---

# MCP resource templates should be optional in health checks

## Problem

A backend health check can falsely report an MCP server as unavailable when the server supports concrete resources but does not implement resource templates. The visible failure is confusing because core operations such as tool listing and resource listing may still work.

## Symptoms

- `caplets check-backend posthog --format json` returned `status: "unavailable"` with `MCP error -32601: Method not found`.
- `caplets list-tools posthog` and `caplets list-resources posthog` succeeded.
- `caplets list-resource-templates posthog` returned the same method-not-found error.

## What Didn't Work

- Treating the healthcheck failure as an auth or connectivity problem did not match the evidence: authenticated tool calls and resource listing were already succeeding.
- Checking only `tools/list` did not explain why `check-backend` failed, because the health check also probes optional MCP surfaces.

## Solution

Treat resource-template listing as optional when a server reports resources support. If `resources/templates/list` returns method-not-found, normalize that response to `UNSUPPORTED_CAPABILITY`, set the health payload's `resourceTemplates` capability to `false`, and keep the backend available.

```ts
try {
  resourceTemplateCount = (await this.listResourceTemplates(server, true)).length;
} catch (error) {
  if (!isUnsupportedCapability(error)) throw error;
  capabilitySummary.resourceTemplates = false;
}
```

When normalizing the method-not-found response, replace the cached template list with an empty array and refresh its timestamp before throwing `UNSUPPORTED_CAPABILITY`. That clears any stale templates from earlier successful probes and avoids repeated live calls to a known-unsupported method during the cache TTL.

Add a regression test with an HTTP MCP fixture that advertises resources, implements `tools/list` and `resources/list`, but returns JSON-RPC `-32601` for `resources/templates/list`. The health check should return `status: "available"`, `resourceTemplateCount: 0`, and leave the registry status available.

## Why This Works

In MCP, concrete resources and resource templates are related but not equivalent capabilities. A server can be a healthy resources-capable backend without supporting templated resource URIs. The health check should therefore separate required backend availability from optional surface probing.

## Prevention

- When adding MCP capability probes, distinguish advertised core capabilities from optional methods that may still be absent.
- Regression tests should cover partially implemented MCP surfaces, not only servers that advertise tools.
- For health checks, optional surface failures should degrade the reported capability summary instead of changing the whole backend status.

## Related Issues

- Captured from PR #157 investigation.
