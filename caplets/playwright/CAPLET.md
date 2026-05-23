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
    - "@playwright/mcp@0.0.75"
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

This Caplet starts Playwright MCP with `npx -y @playwright/mcp@0.0.75 --headless`.

Remove `--headless`, or set `PLAYWRIGHT_MCP_HEADLESS=false` in a custom MCP
environment, to use a visible browser. For advanced settings, create a
Playwright MCP JSON config file in your project (for example,
`.caplets/playwright-mcp.json`) and add `--config .caplets/playwright-mcp.json`
to the args.
