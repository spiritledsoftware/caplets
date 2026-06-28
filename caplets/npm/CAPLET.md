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

Use this Caplet when the agent needs public npm package facts before choosing dependencies, checking versions, comparing package health, or validating registry metadata.

## First Workflow

1. Use `get_dist_tags` or `get_package_version` when the package name and version are known.
2. Use `get_package` when you need release history, maintainers, versions, and package metadata together.
3. Use `search_packages` for discovery, then inspect exact packages before recommending one.
4. Pair package facts with local lockfile and test evidence before changing dependencies.

## Operate Carefully

- Registry metadata can be stale relative to the local lockfile. Check the project dependency state before editing.
- Package search ranking is not a safety signal. Inspect maintainers, versions, and vulnerability context before suggesting adoption.
- Use OSV for vulnerability lookups; this Caplet provides package metadata, not a complete security review.
