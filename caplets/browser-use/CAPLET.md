---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Browser Use
description: Drive the user's real browser through Playwright MCP for local control.
tags:
  - browser
  - playwright
  - mcp
mcpServer:
  command: npx
  args:
    - -y
    - "@playwright/mcp@latest"
    - --extension
---

# Browser Use

Use this Caplet when an agent needs a local browser to inspect pages, gather current web context, or exercise browser-based workflows.

## Setup

Install Playwright browser dependencies for the runtime where this Caplet runs. If you need a specific browser executable or profile, create a private variant that uses environment variables such as `DEFAULT_BROWSER_EXECUTABLE_PATH` and `DEFAULT_BROWSER_USER_DATA_DIR`.

## Safety

This is a local-control Caplet. Browser actions can sign in, submit forms, trigger purchases, or change account data. Prefer navigation, reading, and screenshots first; review mutating interactions before execution.
