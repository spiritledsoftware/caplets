---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Stripe
description: Inspect and manage Stripe accounts, API resources, documentation, reports, refunds, and payments through Stripe's hosted MCP server.
tags:
  - stripe
  - payments
  - billing
  - finance
  - api
catalog:
  icon: https://stripe.com/favicon.ico
mcpServer:
  url: https://mcp.stripe.com
  auth:
    type: oauth2
---

# Stripe

## Prerequisites

Confirm the intended Stripe mode, account, and workspace before reading or changing resources. Resource checks should include exact IDs, amounts, currency, `livemode` status, and relevant event history.

## Safe operation

Inspect Stripe documentation and current API resource state before writes or integration changes. Before mutating a customer, payment, invoice, subscription, refund, report, or account setting, review the exact target and expected result.

Stripe operations can affect money movement, customer billing, disputes, accounting, and compliance. Prefer read-only inspection, and explicitly confirm test mode versus live mode before refunds, cancellations, subscription updates, or account-configuration changes.

## Sensitive data

Do not reproduce payment method details, customer PII, API keys, webhook secrets, or restricted report data in logs or summaries.
