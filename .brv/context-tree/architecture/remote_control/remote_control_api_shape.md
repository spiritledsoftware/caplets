---
title: Remote Control API Shape
summary: Remote control API shape with unified environment selection, CLI remote mode resolution, and working/context modules for routing remote actions.
tags: []
related: [architecture/remote_control/working_module.md, architecture/remote_control/unified_environment_variable_interface.md, architecture/remote_control/cli_remote_mode_selection.md, architecture/auth/remote_auth_and_state_ownership.md, architecture/remote_control/context.md, architecture/remote_control/cli_remote_mode_selection.md, architecture/remote_control/unified_environment_variable_interface.md, architecture/remote_control/context_module.md, architecture/remote_control/working_module.md]
keywords: []
createdAt: '2026-05-20T11:07:38.964Z'
updatedAt: '2026-05-20T15:42:10.341Z'
---

## Reason

Curate remote control API shape, environment selection, and routing behavior from the provided RLM context.

## Raw Concept

**Task:**
Document the remote control API shape and its related execution model.

**Changes:**
- Defined a command-semantic /control endpoint
- Specified structured request and response envelopes
- Outlined a multi-step auth login flow
- Captured API shape details
- Recorded command routing and ownership rules
- Preserved execution and state-handling behavior
- Captured the remote control API shape and surrounding module responsibilities.
- Recorded CLI remote mode selection and unified environment variable interface behavior.
- Preserved task-specific review findings related to context and working modules.

**Files:**
- caplets/github/CAPLET.md
- caplets/github-cli/CAPLET.md
- caplets/linear/CAPLET.md
- caplets/repo-cli/CAPLET.md
- caplets/context7.md

**Flow:**
CLI input -> remote mode selection -> context/working module resolution -> remote action routing

**Timestamp:** 2026-05-20T15:42:02.926Z

## Narrative

### Structure

This topic groups the remote control API shape together with selection and context-handling modules that determine how remote actions are routed.

### Dependencies

Depends on CLI remote mode selection, unified environment variable handling, and the context/working module split.

### Highlights

Captures the architectural shape of remote control behavior and the supporting module responsibilities in the caplets system.

### Rules

No remote request is ever “run this CLI string”.
No shelling out to `caplets` on the server.

### Examples

Example request: POST /control { command: "list_tools", arguments: {} }
Example login flow: auth_login_start returns authorizationUrl and flowId, then auth_login_complete exchanges credentials.

## Facts

- **remote_mode_selection**: Remote mode selection is resolved through CLI remote mode selection logic. [project]
- **environment_variable_interface**: The remote control layer uses a unified environment variable interface. [project]
- **remote_control_modules**: Context and working modules are part of the remote control architecture. [project]
