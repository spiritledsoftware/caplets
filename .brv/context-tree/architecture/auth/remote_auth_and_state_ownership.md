---
title: Remote Auth and State Ownership
summary: Remote mode keeps all Caplets state and downstream auth credentials on the server; local clients only coordinate login/logout flows and must never receive secrets.
tags: []
related: [architecture/remote_control/working_module.md, architecture/remote_control/unified_environment_variable_interface.md, architecture/remote_control/cli_remote_mode_selection.md, architecture/remote_control/remote_control_api_shape.md]
keywords: []
createdAt: '2026-05-20T11:04:45.510Z'
updatedAt: '2026-05-20T11:04:45.510Z'
---
## Reason
Document the decision that server owns auth creds and Caplets state in remote mode

## Raw Concept
**Task:**
Document remote auth and state ownership model for Caplets

**Changes:**
- Server owns Caplets config, .caplets files, installed Caplets, backend definitions, OAuth/token auth store, and reload/watch lifecycle in remote mode
- Login/logout commands operate against the remote server auth store when invoked from a local client
- Remote responses must not expose access tokens or secrets

**Flow:**
local client -> remote control command -> browser/device auth flow -> server stores final tokens -> subsequent auth/status operations read server-side state

**Timestamp:** 2026-05-20T11:04:32.841Z

## Narrative
### Structure
This design centers on server-owned state for remote mode, with local terminals acting as coordinators for auth flows rather than state holders.

### Dependencies
Applies to auth list/logout/login behavior, remote control API shape, and any future remote config-paths command.

### Highlights
A local caplets auth login linear command should complete against the remote server’s auth store, while `/control` responses remain secret-free.

### Rules
Remote control API responses must never include access tokens or secrets. Remote control auth (the Basic Auth used to access `/control`) is separate from downstream provider auth (GitHub/Linear/etc.).

### Examples
auth list shows server-side credential status; auth logout <server> deletes server-side credentials; config paths defaults to local paths and can later support a remote variant.

## Facts
- **remote_state_ownership**: In remote mode, the server owns all Caplets state. [project]
- **auth_store_location**: OAuth and token auth store live on the server in remote mode. [project]
- **secret_exposure_policy**: Remote control API responses must never include access tokens or secrets. [project]
- **auth_boundary**: Remote control auth is separate from downstream provider auth. [project]
- **config_paths_default**: Local caplets config paths should show local paths by default. [project]
