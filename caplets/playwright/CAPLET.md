---
# yaml-language-server: $schema=https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: Playwright
description: Drive a browser through Playwright MCP for frontend testing, inspection, and automation workflows.
tags:
  - browser
  - testing
  - mcp
  - frontend
setup:
  commands:
    - label: Install Playwright MCP
      command: npm
      args: ["install", "-g", "@playwright/mcp@0.0.75"]
      timeoutMs: 120000
      maxOutputBytes: 200000
    - label: Install Chromium browser
      command: npx
      args: ["playwright", "install", "chromium"]
      timeoutMs: 180000
      maxOutputBytes: 200000
  verify:
    - label: Check Playwright MCP
      command: playwright-mcp
      args: ["--help"]
      timeoutMs: 10000
      maxOutputBytes: 20000
mcpServer:
  command: playwright-mcp
  args:
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

This Caplet installs `@playwright/mcp@0.0.75` globally with npm, installs the Chromium browser
runtime with `npx playwright install chromium`, then verifies `playwright-mcp --help`. Setup is
explicit because browser automation needs both a stable MCP binary and a browser runtime before the
hosted or local stdio server starts.

Remove `--headless`, or set `PLAYWRIGHT_MCP_HEADLESS=false` in a custom MCP
environment, to use a visible browser. For advanced settings, create a
Playwright MCP JSON config file in your project (for example,
`.caplets/playwright-mcp.json`) and add `--config .caplets/playwright-mcp.json`
to the args.
