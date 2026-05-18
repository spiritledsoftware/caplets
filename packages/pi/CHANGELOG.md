# @caplets/pi

## 0.1.6

### Patch Changes

- 43127ff: Fix package resolution for native extensions and modernize everything to typescript
- Updated dependencies [43127ff]
  - @caplets/core@0.13.1

## 0.1.5

### Patch Changes

- 5bfb950: Improve Pi caplet extension registration by using the generated core input schema, declaring the built extension in the package manifest, deferring active-tool synchronization until session start, and adding compact tool call/result rendering.
- Updated dependencies [c349e62]
  - @caplets/core@0.13.0

## 0.1.4

### Patch Changes

- Updated dependencies [e9dd9e8]
  - @caplets/core@0.12.2

## 0.1.3

### Patch Changes

- 864feaf: Native integrations now share the hot-reload runtime so existing native tools execute against
  the latest valid Caplets config; Pi can register newly added Caplet tools and deactivate stale
  ones at runtime when its active-tool APIs are available.
- Updated dependencies [864feaf]
  - @caplets/core@0.12.1

## 0.1.2

### Patch Changes

- fac459f: Add repository metadata required for npm trusted publishing.

## 0.1.1

### Patch Changes

- 4988e28: Fix npm publishing for public scoped integration packages.

## 0.1.0

### Minor Changes

- aa7d09d: Split Caplets into a pnpm monorepo with a reusable `@caplets/core` runtime package and keep the existing `caplets` CLI package as the published command-line entrypoint.

  Add native agent integrations for OpenCode and Pi that expose configured Caplets as prefixed native tools while reusing the same Caplets config and backend execution runtime.

### Patch Changes

- Updated dependencies [aa7d09d]
  - @caplets/core@0.12.0
