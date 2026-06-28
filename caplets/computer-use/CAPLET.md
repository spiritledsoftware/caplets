---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Computer Use
description: Control local desktop applications and windows through open-computer-use for explicit desktop automation workflows.
tags:
  - computer-use
  - desktop
  - local-control
mcpServer:
  command: npx
  args:
    - -y
    - open-computer-use@latest
    - mcp
---

# Computer Use

Use this Caplet only when an agent needs explicit access to the local desktop, application windows, or GUI workflows that cannot be completed through APIs or CLI tools.

## First Workflow

1. Identify the target application, window, and desired outcome before interacting.
2. Observe the screen and report the intended next action before changing state.
3. Prefer menu/navigation/read actions before typing, clicking submit buttons, or changing settings.
4. Stop after completing the narrow GUI step the user requested.

## Operate Carefully

- This is a high-risk local-control Caplet. It can operate real applications and expose private screen content.
- Do not use it for credential entry, payment flows, destructive file operations, account settings, or irreversible actions without direct user instruction.
- Prefer provider APIs, CLI tools, or browser automation when those can complete the task with a smaller control surface.
