---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Computer Use
description: Control local desktop applications and windows through open-computer-use for explicit desktop automation workflows.
useWhen: Use only for desktop, application-window, or GUI work that cannot be completed through a smaller API or CLI surface.
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

## Targeting and Observation

- The operator should identify the target application, window, and intended outcome before interaction.
- Screen observation should precede state changes, with the proposed next action made clear.
- Menu, navigation, and read actions provide a safer starting point than typing, submitting, or changing settings.
- Automation should stop once the requested narrow GUI operation is complete.

## Safe Operation

- This is a high-risk local-control capability that can operate real applications and expose private screen content.
- Credential entry, payment flows, destructive file operations, account-setting changes, and other irreversible actions require direct user instruction.
