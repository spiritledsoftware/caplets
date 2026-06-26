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

## Safety

This is a high-risk local-control Caplet. It can operate real applications and may expose private screen content. Keep tasks narrow, identify the target application before acting, and do not use it for credential entry, payment flows, or irreversible actions without direct user instruction.
