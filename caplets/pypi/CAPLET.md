---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: PyPI Registry
description: Query Python package metadata, releases, files, vulnerabilities, and Simple API project details from PyPI.
tags:
  - openapi
  - pypi
  - python
  - packages
  - code
catalog:
  icon: https://pypi.org/static/images/logo-small.8998e9d1.svg
openapiEndpoint:
  specPath: ./pypi.openapi.yaml
  auth:
    type: none
---

# PyPI Registry

## Package lookup

- `get_project` returns current project metadata, release history, project URLs, and vulnerability records included by PyPI.
- `get_release` provides details for an exact project version.
- `get_simple_project` provides Simple API file links and hashes for dependency tooling.

Cross-check registry results against the repository lockfile, the active Python environment, and tests before changing dependencies.

## Limits

PyPI metadata is read-only, can become stale, and is not a complete supply-chain assessment. Verify the version that is actually installed locally. Deprecated XML-RPC APIs are intentionally excluded; the supported operations use PyPI's JSON and Simple API endpoints.
