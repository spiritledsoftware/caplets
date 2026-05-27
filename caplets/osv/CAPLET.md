---
# yaml-language-server: $schema=https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: OSV Vulnerabilities
description: Query OSV.dev vulnerability data through explicit HTTP actions.
tags:
  - security
  - vulnerabilities
  - http
  - code
httpApi:
  baseUrl: https://api.osv.dev
  auth:
    type: none
  actions:
    query_package_version:
      description: Read-only OSV query for vulnerabilities affecting one package ecosystem/name/version tuple.
      method: POST
      path: /v1/query
      inputSchema:
        type: object
        properties:
          name:
            type: string
            description: Package name, such as lodash, requests, or openssl.
          ecosystem:
            type: string
            description: OSV ecosystem, such as npm, PyPI, Maven, Go, crates.io, Packagist, RubyGems, NuGet, Debian, or Alpine.
          version:
            type: string
            description: Package version to query.
          page_token:
            type: string
            description: Optional pagination token returned by OSV.
        required:
          - name
          - ecosystem
          - version
      jsonBody:
        package:
          name: $input.name
          ecosystem: $input.ecosystem
        version: $input.version
        page_token: $input.page_token
    query_purl:
      description: Read-only OSV query for vulnerabilities affecting one package URL (purl).
      method: POST
      path: /v1/query
      inputSchema:
        type: object
        properties:
          purl:
            type: string
            description: Package URL, such as pkg:npm/lodash@4.17.20 or pkg:pypi/requests@2.19.0.
          page_token:
            type: string
            description: Optional pagination token returned by OSV.
        required:
          - purl
      jsonBody:
        package:
          purl: $input.purl
        page_token: $input.page_token
    query_commit:
      description: Read-only OSV query for vulnerabilities associated with one source commit hash.
      method: POST
      path: /v1/query
      inputSchema:
        type: object
        properties:
          commit:
            type: string
            description: Source commit hash to query.
          page_token:
            type: string
            description: Optional pagination token returned by OSV.
        required:
          - commit
      jsonBody:
        commit: $input.commit
        page_token: $input.page_token
    query_batch:
      description: Read-only OSV batch query for multiple package, purl, commit, or version requests.
      method: POST
      path: /v1/querybatch
      inputSchema:
        type: object
        properties:
          queries:
            type: array
            description: OSV query objects accepted by /v1/querybatch.
            items:
              type: object
              additionalProperties: true
        required:
          - queries
      jsonBody:
        queries: $input.queries
    get_vulnerability:
      description: Read-only OSV lookup for one vulnerability record by OSV, CVE, or GHSA identifier.
      method: GET
      path: /v1/vulns/{id}
      inputSchema:
        type: object
        properties:
          id:
            type: string
            description: Vulnerability identifier, such as OSV-2020-744, CVE-2021-44228, or GHSA-jfh8-c2jp-5v3q.
        required:
          - id
---

# OSV Vulnerabilities

Use this Caplet to query OSV.dev for known vulnerabilities affecting package
versions, package URLs, source commits, or known vulnerability IDs.

## Usage Notes

- All actions are read-only HTTP requests against the public OSV API.
- Use `query_package_version` when you know the package ecosystem, name, and exact version.
- Use `query_purl` when tooling already produced a package URL such as `pkg:npm/lodash@4.17.20`.
- Use `query_commit` for source-level checks against a commit hash.
- Use `query_batch` to check multiple packages or commits in one request.
- Use `get_vulnerability` when you already have an OSV, CVE, or GHSA identifier.

## Ecosystems

Common OSV ecosystems include `npm`, `PyPI`, `Maven`, `Go`, `crates.io`,
`Packagist`, `RubyGems`, `NuGet`, `Debian`, `Alpine`, and `OSS-Fuzz`.

## Examples

- Query npm package version: `name: lodash`, `ecosystem: npm`, `version: 4.17.20`.
- Query Python package version: `name: requests`, `ecosystem: PyPI`, `version: 2.19.0`.
- Query a purl: `purl: pkg:npm/lodash@4.17.20`.
- Fetch a vulnerability: `id: CVE-2021-44228`.
