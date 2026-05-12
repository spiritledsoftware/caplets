# caplets

## 0.2.1

### Patch Changes

- f936020: Load project config from `./.caplets/config.json` alongside user config, with project values taking precedence while preserving user-only servers. Fix OAuth login token exchange for clients with secret authentication, and clarify generated Caplets tool descriptions so downstream tool inputs are passed under `call_tool.arguments`.

## 0.2.0

### Minor Changes

- 0d4c5df: Add the Caplets configuration quickstart, generated JSON Schema support, top-level config options, and Commander-based CLI commands for init and OAuth auth management.

## 0.1.0

### Minor Changes

- 34da37a: Set up release automation with Changesets, Husky hooks, and GitHub Actions CI/release workflows.
