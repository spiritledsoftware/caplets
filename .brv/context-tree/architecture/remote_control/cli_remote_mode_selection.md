---
title: CLI Remote Mode Selection
summary: Remote control uses CAPLETS_MODE with auto/local/remote selection, independent server URL and credentials, and remote mode coordinates server-owned state and auth flows.
tags: []
related: [architecture/remote_control/working_module.md, architecture/remote_control/unified_environment_variable_interface.md, architecture/remote_control/remote_control_api_shape.md, architecture/auth/remote_auth_and_state_ownership.md, architecture/remote_control/context.md]
keywords: []
createdAt: '2026-05-20T11:09:24.904Z'
updatedAt: '2026-05-20T11:32:37.464Z'
---

## Reason

Curate remote control mode selection and execution rules from context

## Raw Concept

**Task:**
Document CLI remote mode selection and working module behavior

**Changes:**
- Removed dependency on CAPLETS_NATIVE_MODE for CLI routing
- Established CAPLETS_REMOTE_URL as the remote-mode trigger
- Recorded command-level routing exceptions and remote-capable commands
- Introduced CAPLETS_CLI_MODE as separate CLI-specific mode control
- Preserved remote connection settings independently via CAPLETS_REMOTE_URL, CAPLETS_REMOTE_USER, and CAPLETS_REMOTE_PASSWORD
- Defined routing rules for auto, local, and remote CLI modes
- Clarified that CAPLETS_NATIVE_MODE is not used for CLI routing
- CAPLETS_MODE is the selector for auto/local/remote mode selection
- CAPLETS_SERVER_URL and credentials are independent and required for remote mode
- Remote mode uses server-owned state and the local client coordinates auth flows

**Flow:**
select mode -> resolve server URL and credentials -> if remote, coordinate auth flow with server-owned state -> execute remote control operations

**Timestamp:** 2026-05-20T11:32:32.346Z

**Patterns:**
- `^CAPLETS_CLI_MODE=(auto|local|remote)$` - Valid CLI mode values
- `^CAPLETS_REMOTE_URL=.+$` - Remote backend URL configuration

## Narrative

### Structure

The remote control architecture separates mode selection from server configuration and auth handling. The client selects auto, local, or remote via CAPLETS_MODE, while CAPLETS_SERVER_URL and credentials are handled independently.

### Dependencies

Remote mode depends on server availability, explicit server URL configuration, and credentials. The client must not expose tokens or secrets.

### Highlights

Remote control API is command-semantic via structured /control endpoints, not raw CLI-string execution on the server. Remote mode owns durable state on the server side.

### Rules

1. CAPLETS_CLI_MODE=auto or unset: use remote for remote-capable commands when CAPLETS_REMOTE_URL is set; otherwise use local.
2. CAPLETS_CLI_MODE=local: always use local, even if CAPLETS_REMOTE_URL is set.
3. CAPLETS_CLI_MODE=remote: require CAPLETS_REMOTE_URL and fail fast with a clear config error if missing.
4. CAPLETS_NATIVE_MODE remains native-integration-specific for OpenCode/Pi and is not used for CLI routing.

### Examples

Examples include CAPLETS_CLI_MODE=local caplets list to keep remote settings but force local, CAPLETS_CLI_MODE=remote caplets list to force remote, and caplets list using remote automatically when CAPLETS_REMOTE_URL is set.
