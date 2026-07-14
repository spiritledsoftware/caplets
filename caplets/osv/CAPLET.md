---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: OSV Vulnerabilities
description: Query OSV.dev vulnerability data through explicit HTTP actions.
tags:
  - security
  - vulnerabilities
  - http
  - code
catalog:
  icon: https://osv.dev/favicon.ico
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

## Query Reference

- An exact ecosystem, package name, and version provides the most specific dependency check.
- Package URLs (purls) are suitable when dependency tooling has already produced normalized identifiers.
- Related dependency checks can be submitted as a batch.
- An OSV, CVE, or GHSA identifier can be used to retrieve the full vulnerability record and remediation context.

## Limits

- OSV results are read-only and public, but absence of a result is not proof that a dependency is safe.
- Ecosystem names must match OSV exactly, including `npm`, `PyPI`, `Maven`, `Go`, `crates.io`, `Packagist`, `RubyGems`, `NuGet`, `Debian`, `Alpine`, and `OSS-Fuzz`.
- The actual installed version should be verified with local project tooling.
