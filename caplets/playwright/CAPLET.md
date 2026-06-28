---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Playwright
description: Drive a browser through Playwright MCP for frontend testing, inspection, and automation workflows.
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

Use this Caplet when the agent needs an isolated browser automation surface for frontend debugging, accessibility checks, visual inspection, or end-to-end testing workflows.

## First Workflow

1. Open the target local or preview URL and wait for the page to settle.
2. Inspect visible state, accessibility tree, console errors, network behavior, or screenshots before acting.
3. Reproduce the smallest user flow that proves or disproves the issue.
4. Capture concise evidence for the code change or review.

## Operate Carefully

- This Caplet runs a browser runtime. Keep tests scoped to the target app and avoid unrelated browsing.
- Prefer this over Browser Use for isolated test flows; use Browser Use only when the user's real signed-in browser context matters.
- If browser setup is missing, treat the Caplet as unavailable until setup verification succeeds rather than improvising shell installs.
