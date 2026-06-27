---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: npm Registry
description: Query package metadata, versions, dist-tags, and search results from the public npm registry.
tags:
  - openapi
  - npm
  - packages
  - code
openapiEndpoint:
  specUrl: https://raw.githubusercontent.com/npm/api-documentation/main/api/base.yaml
  auth:
    type: none
---

# npm Registry

Use this Caplet to inspect npm registry operations through npm's published
OpenAPI description of the public registry API.

## Usage Notes

- Use `get_package` to fetch packument metadata for a package, including versions and dist-tags.
- Use `get_package_version` when you need metadata for one exact published version.
- Use `get_dist_tags` to read the package's current dist-tags without fetching the full packument.
- Use `search_packages` to find packages by npm registry search text and ranking weights.

## Examples

- Fetch React packument metadata: `packageName: react`.
- Fetch TypeScript version metadata: `packageName: typescript`, `version: 5.8.3`.
- Search packages: `text: keywords:react hooks`, `size: 10`.
