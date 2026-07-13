---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Playwright
description: Drive a browser through Playwright MCP for frontend testing, inspection, and automation workflows.
useWhen: Use for isolated browser testing, frontend inspection, accessibility checks, visual inspection, and end-to-end workflows.
avoidWhen: Avoid when work requires the user's real signed-in browser context; use Browser Use instead.
tags:
  - browser
  - testing
  - mcp
  - frontend
catalog:
  icon: https://playwright.dev/img/playwright-logo.svg
setup:
  commands:
    - label: Install Playwright MCP
      command: npm
      args: ["install", "-g", "@playwright/mcp@latest"]
      timeoutMs: 120000
      maxOutputBytes: 200000
    - label: Install Chromium browser
      command: npx
      args: ["-y", "playwright@latest", "install", "chromium"]
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

## Test Workflow

A local or preview URL is the starting point for an isolated browser session. Visible state, the accessibility tree, console errors, network behavior, and screenshots provide evidence before interaction. The smallest reproducible user flow should prove or disprove the issue, with concise evidence retained for the resulting change or review.

## Safe Operation

- This Caplet runs an isolated browser runtime. Tests should remain scoped to the target application and avoid unrelated browsing.
- If browser setup is missing, the Caplet remains unavailable until setup verification succeeds; operators should use the declared setup rather than improvising shell installation.
