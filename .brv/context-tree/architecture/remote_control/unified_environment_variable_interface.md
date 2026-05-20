---
title: Unified Environment Variable Interface
summary: Unified Caplets env interface uses CAPLETS_MODE plus CAPLETS_SERVER_* vars, with deprecated aliases and explicit precedence rules.
tags: []
related: [architecture/remote_control/remote_control_api_shape.md, architecture/remote_control/cli_remote_mode_selection.md, architecture/remote_control/working_module.md, architecture/auth/remote_auth_and_state_ownership.md, architecture/remote_control/context.md]
keywords: []
createdAt: '2026-05-20T11:12:05.554Z'
updatedAt: '2026-05-20T11:12:05.554Z'
---
## Reason
Document the agreed unified environment variable model for Caplets CLI, native integrations, and serve/client modes

## Raw Concept
**Task:**
Document the unified environment variable interface for Caplets

**Changes:**
- Replaced CAPLETS_NATIVE_* with CAPLETS_MODE and CAPLETS_SERVER_* variables
- Defined resolution rules for auto, local, and remote modes
- Added backward-compatible alias mappings for one release path
- Specified env-to-CLI derivation for caplets serve and client mode

**Files:**
- caplets/github/README.md
- caplets/github-cli/CAPLET.md

**Flow:**
config/options -> unified env vars -> deprecated aliases -> defaults

**Timestamp:** 2026-05-20T11:11:45.922Z

**Patterns:**
- `^CAPLETS_MODE=(auto|local|remote)$` - Allowed unified mode values
- `^CAPLETS_SERVER_URL=.+$` - Server URL setting used by serve and client mode

## Narrative
### Structure
The design centralizes all runtime selection around CAPLETS_MODE and a single CAPLETS_SERVER_* namespace, while preserving old variables as deprecated aliases.

### Dependencies
Relies on explicit host config or CLI options taking highest precedence, with environment variables filling in defaults for serving and client behavior.

### Highlights
The model simplifies configuration, keeps backward compatibility for one release path, and derives control/MCP endpoints from the same base server URL.

### Rules
1. CAPLETS_MODE=auto or unset uses remote/client mode when CAPLETS_SERVER_URL is set, otherwise local mode.
2. CAPLETS_MODE=local always forces local mode, even if server settings exist.
3. CAPLETS_MODE=remote requires CAPLETS_SERVER_URL and fails fast if missing.
4. If both old and new env vars are present, the new unified variable wins.
5. Explicit CLI flags still override env values for caplets serve.

## Facts
- **caplets_mode**: CAPLETS_MODE is the single mode selector and can be auto, local, or remote. [project]
- **caplets_server_url**: CAPLETS_SERVER_URL is used by caplets serve and caplets client mode. [project]
- **caplets_server_auth**: CAPLETS_SERVER_USER and CAPLETS_SERVER_PASSWORD provide Basic Auth credentials for serving and client/server configuration. [project]
- **deprecated_alias_native_mode**: CAPLETS_NATIVE_MODE maps to CAPLETS_MODE as a deprecated alias. [project]
- **deprecated_alias_remote_url**: CAPLETS_REMOTE_URL maps to CAPLETS_SERVER_URL as a deprecated alias. [project]
- **deprecated_alias_remote_user**: CAPLETS_REMOTE_USER maps to CAPLETS_SERVER_USER as a deprecated alias. [project]
- **deprecated_alias_remote_password**: CAPLETS_REMOTE_PASSWORD maps to CAPLETS_SERVER_PASSWORD as a deprecated alias. [project]
- **caplets_mode_resolution**: When CAPLETS_MODE is auto or unset, remote/client mode is used if CAPLETS_SERVER_URL is set; otherwise local mode is used. [project]
- **caplets_local_override**: When CAPLETS_MODE is local, local mode is used even when server settings exist. [project]
- **caplets_remote_requirement**: When CAPLETS_MODE is remote, CAPLETS_SERVER_URL is required and missing it is a fast failure. [project]
- **caplets_precedence**: Precedence is explicit host config/options, then new unified env vars, then deprecated aliases, then defaults. [project]
- **caplets_env_conflict_resolution**: If both old and new env vars are present, the new unified variable wins. [project]
- **caplets_deprecation_warning**: The CLI and native integrations may warn once when deprecated aliases are used. [project]
- **caplets_serve_url_derivation**: caplets serve --transport http can derive host, port, and path from CAPLETS_SERVER_URL. [project]
- **caplets_cli_override**: Explicit CLI flags override environment variables for caplets serve. [project]
- **caplets_control_endpoint**: Client mode derives MCP endpoint from CAPLETS_SERVER_URL and control endpoint from the same base URL plus /control. [project]
- **caplets_control_url_escape_hatch**: CAPLETS_CONTROL_URL is an optional future escape hatch for separate control endpoints. [project]
