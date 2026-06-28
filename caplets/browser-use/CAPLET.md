---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Browser Use
description: Drive the user's real browser through Playwright MCP for local control.
tags:
  - browser
  - playwright
  - mcp
catalog:
  icon: https://playwright.dev/img/playwright-logo.svg
mcpServer:
  command: npx
  args:
    - -y
    - "@playwright/mcp@latest"
    - --extension
---

# Browser Use

Use this Caplet when the agent needs the user's real local browser context: signed-in web apps, current tabs, extension-backed inspection, or browser workflows that a headless test browser cannot reproduce.

## First Workflow

1. Identify the target page, tab, or workflow before interacting.
2. Read page state with navigation, screenshots, accessibility snapshots, or DOM inspection first.
3. Keep interactions minimal and reversible until the user asks for a concrete action.
4. Capture the evidence needed for the coding or debugging task, then stop.

## Operate Carefully

- Browser actions can sign in, submit forms, trigger purchases, or change account data in the user's real browser.
- Do not enter credentials, approve payments, submit destructive forms, or change account settings without explicit user direction.
- Prefer Playwright for isolated frontend testing; use this Caplet when the real browser environment matters.
