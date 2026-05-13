# caplets

## 0.8.0

### Minor Changes

- 349459a: Add native HTTP actions for explicitly configured non-OpenAPI APIs.

## 0.7.0

### Minor Changes

- 359eba4: # Hot reload serve config

  Add default hot reload for `caplets serve`, including live config and Caplet file reconciliation without restarting the MCP process.

### Patch Changes

- 85bfe0c: Use the MCP SDK OAuth auth provider for remote OAuth MCP transports instead of precomputing static bearer headers, allowing SDK-managed refresh, resource metadata, and auth challenge handling.

## 0.6.0

### Minor Changes

- ad63f47: # CLI inspection and Caplet installation

  Add CLI inspection commands for version, configured Caplets, resolved config paths, and installing Caplets from a repo.

## 0.5.2

### Patch Changes

- 99bce4a: Fix MCP OAuth/OIDC token exchange for dynamically registered clients.

## 0.5.1

### Patch Changes

- bcd0dde: Fix MCP OAuth/OIDC login for configured public clients by including the client ID in the token exchange.

## 0.5.0

### Minor Changes

- 6e5ec50: Add native GraphQL Caplets with configured or auto-generated operations, OAuth/OIDC discovery for OpenAPI and GraphQL backends, and safer credential handling for discovered auth flows.

## 0.4.0

### Minor Changes

- 9c9f3e2: Add native OpenAPI-backed Caplets alongside MCP server backends.

  OpenAPI endpoint configs can now expose one generated Caplet tool per API spec, progressively disclose operations as tools, and execute HTTP calls through the existing `call_tool` flow. The implementation includes explicit OpenAPI auth configuration, safe spec loading, guarded request construction, generated schema updates, and documentation for `openapiEndpoints`.

## 0.3.0

### Minor Changes

- b924a7b: Add MCP-backed Markdown Caplet files with Caplet-first discovery operations.

## 0.2.1

### Patch Changes

- f936020: Load project config from `./.caplets/config.json` alongside user config, with project values taking precedence while preserving user-only servers. Fix OAuth login token exchange for clients with secret authentication, and clarify generated Caplets tool descriptions so downstream tool inputs are passed under `call_tool.arguments`.

## 0.2.0

### Minor Changes

- 0d4c5df: Add the Caplets configuration quickstart, generated JSON Schema support, top-level config options, and Commander-based CLI commands for init and OAuth auth management.

## 0.1.0

### Minor Changes

- 34da37a: Set up release automation with Changesets, Husky hooks, and GitHub Actions CI/release workflows.
