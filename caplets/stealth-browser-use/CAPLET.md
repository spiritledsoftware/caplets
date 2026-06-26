---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Stealth Browser Use
description: Drive a stealth-configured local Playwright browser for web workflows that need a non-default browser profile.
tags:
  - browser
  - playwright
  - stealth
  - local-control
mcpServer:
  command: npx
  args:
    - -y
    - "@playwright/mcp@latest"
    - "--config=$env:CAPLETS_STEALTH_PLAYWRIGHT_CONFIG"
    - --browser=firefox
    - "--executable-path=$env:CAPLETS_STEALTH_BROWSER_EXECUTABLE"
    - "--user-data-dir=$env:CAPLETS_STEALTH_BROWSER_USER_DATA_DIR"
    - --headless
---

# Stealth Browser Use

Use this Caplet when a workflow needs a dedicated local browser profile and the ordinary Browser Use Caplet is not suitable.

## Setup

Create a local Playwright MCP config file and set:

- `CAPLETS_STEALTH_PLAYWRIGHT_CONFIG`
- `CAPLETS_STEALTH_BROWSER_EXECUTABLE`
- `CAPLETS_STEALTH_BROWSER_USER_DATA_DIR`

Do not check browser profiles, cookies, or machine-specific paths into a public Caplet.

## Safety

This is a local-control Caplet. Follow site terms, avoid credential entry, and review any mutating browser interaction before it runs.
