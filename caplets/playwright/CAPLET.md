---
$schema: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: Playwright
description: Drive a browser through Playwright MCP for frontend testing, inspection, and automation workflows.
tags:
  - browser
  - testing
  - mcp
  - frontend
mcpServer:
  command: npx
  args:
    - -y
    - "@playwright/mcp@latest"
    - --headless
---

# Playwright

Use this Caplet when the agent needs browser automation for frontend debugging, accessibility checks,
visual inspection, or end-to-end testing workflows.

## Good Fits

- Reproduce frontend bugs in a real browser context.
- Inspect pages, forms, navigation, and interactive states.
- Validate user flows before or after UI changes.
- Gather browser evidence for debugging layout, hydration, or client-side behavior.

## Setup

This Caplet starts Playwright MCP with `npx -y @playwright/mcp@latest --headless`.

Remove `--headless` from the args to use a visible browser. For advanced settings, use a Playwright
MCP config file and update the args to point at that configuration.
