# Caplets

Caplets is a local MCP gateway that exposes configured downstream MCP servers as capability-level tools first, then progressively discloses each server's underlying tools on demand.

## Development

```sh
pnpm install
pnpm verify
```

## Release Flow

User-facing changes should include a changeset:

```sh
pnpm changeset
```

Merging changesets to `main` lets the release workflow open a version PR. Merging that version PR publishes the package to npm through trusted publishing.
