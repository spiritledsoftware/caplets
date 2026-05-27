---
# yaml-language-server: $schema=https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: PyPI
description: Query Python package metadata, releases, files, vulnerabilities, and Simple API project details from PyPI.
tags:
  - openapi
  - pypi
  - python
  - packages
  - code
openapiEndpoint:
  specPath: ./pypi.openapi.yaml
  auth:
    type: none
---

# PyPI

Use this Caplet to inspect Python package metadata through a compact, read-only
OpenAPI description of public PyPI endpoints.

## Spec

The local OpenAPI spec is [pypi.openapi.yaml](./pypi.openapi.yaml).

## API Coverage

- The PyPI JSON API endpoints return project and release metadata, including package info, release files, download URLs, vulnerability records, and maintainer or author ownership fields when PyPI includes them.
- The Simple Repository API endpoint uses PyPI's JSON representation for project file listings. The curated OpenAPI spec supplies `Accept: application/vnd.pypi.simple.v1+json` automatically for `get_simple_project`, so callers only provide `project`.
- Deprecated XML-RPC APIs are intentionally excluded; use these JSON endpoints for agent workflows.

## Usage Notes

- Use `get_project` to fetch current project metadata, releases, URLs, and vulnerability records.
- Use `get_release` when you need metadata for one exact published version.
- Use `get_simple_project` when dependency tooling needs Simple API file links and hashes.

## Examples

- Fetch Requests project metadata: `project: requests`.
- Fetch Django release metadata: `project: django`, `version: 5.0.6`.
- Fetch Simple API JSON: `project: pytest`.
