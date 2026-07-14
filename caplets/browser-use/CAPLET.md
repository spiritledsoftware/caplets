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

## Targeting and Observation

- The operator should identify the target page, tab, and intended outcome before interaction.
- Navigation state, screenshots, accessibility snapshots, and DOM inspection provide an observation-first view of the page.
- Initial interactions should remain minimal and reversible, with evidence collection bounded to the task.

## Safe Operation

- Actions occur in the user's real browser and can sign in, submit forms, trigger purchases, or change account data.
- Credential entry, payment approval, destructive form submission, and account-setting changes require explicit user direction.
