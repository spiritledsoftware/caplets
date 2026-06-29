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

Use this Caplet when an agent needs live Stripe context for payments, customers, subscriptions, invoices, refunds, reports, account settings, API behavior, or Stripe documentation.

## First Workflow

1. Start in the intended Stripe mode, account, and workspace context before reading or changing resources.
2. Search documentation and API resource details before calling write operations or proposing integration code.
3. Inspect exact resource IDs, amounts, currency, livemode status, and event history before acting.
4. Summarize the customer, payment, invoice, subscription, refund, or report target before mutating anything.

## Operate Carefully

- Stripe operations can affect money movement, customer billing, disputes, accounting, and compliance. Prefer read-only inspection before writes.
- Confirm test mode versus live mode explicitly before refunding, canceling, updating subscriptions, or changing account configuration.
- Do not expose payment method details, customer PII, API keys, webhook secrets, or restricted report data in summaries.
- Avoid this Caplet when the task only needs local SDK usage or static API documentation and no live account context.
