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

Use this Caplet when the agent needs public PyPI package facts before choosing dependencies, checking versions, inspecting release files, or validating package metadata.

## First Workflow

1. Use `get_project` for current project metadata, release history, URLs, and vulnerability records included by PyPI.
2. Use `get_release` when an exact version matters.
3. Use `get_simple_project` when dependency tooling needs Simple API file links and hashes.
4. Pair registry facts with the local lockfile, Python environment, and tests before changing dependencies.

## Operate Carefully

- PyPI metadata is read-only but not a full supply-chain assessment.
- Use OSV for cross-ecosystem vulnerability checks and local tooling for the actually installed version.
- Deprecated XML-RPC APIs are intentionally excluded; use these JSON endpoints for agent workflows.
