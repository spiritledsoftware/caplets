---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: npm Registry
description: Query package metadata, versions, dist-tags, and search results from the public npm registry.
tags:
  - openapi
  - npm
  - packages
  - code
catalog:
  icon: https://raw.githubusercontent.com/npm/logos/master/npm%20logo/npm-logo-red.svg
openapiEndpoint:
  specUrl: https://raw.githubusercontent.com/npm/api-documentation/main/api/base.yaml
  auth:
    type: none
---

# npm Registry

## Package Lookups

- `get_dist_tags` and `get_package_version` provide focused lookups when the package name and version are known.
- `get_package` returns release history, maintainers, versions, and package metadata together.
- `search_packages` supports discovery, but candidate packages should be inspected directly before selection.
- Registry facts should be cross-checked with the local lockfile and test evidence before dependency changes.

## Limits and Safety

- Registry metadata can be stale relative to the local lockfile, so the project's actual dependency state remains authoritative.
- Package search ranking is not a safety signal. Maintainers, versions, and vulnerability context require separate inspection before adoption.
- This Caplet provides package metadata, not a complete security review.
