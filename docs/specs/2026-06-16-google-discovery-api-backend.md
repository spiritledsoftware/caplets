# Google Discovery API Backend

## Summary

Add a first-class Google Discovery API backend for Google APIs whose machine-readable contract is a Google Discovery document rather than OpenAPI. The backend should be comprehensive: operation discovery, inferred OAuth scopes, operation filtering, JSON calls, media downloads, media uploads, and Caplet file support all ship as part of the design.

This backend must not live under `openapiEndpoints`. It is a separate backend family with its own source format and manager, while sharing lower-level HTTP, auth, and media artifact infrastructure with other HTTP-like backends.

## Goals

- Add top-level `googleDiscoveryApis` config and `googleDiscoveryApi` Caplet file support.
- Parse Google Discovery documents natively instead of converting them to OpenAPI as the primary abstraction.
- Infer OAuth scopes from exposed Discovery operations unless `auth.scopes` overrides inference.
- Support operation include/exclude filters and compute inferred scopes after filtering.
- Support comprehensive Google media download and upload behavior.
- Add a shared Media artifact contract usable by Google Discovery, OpenAPI, HTTP, and future media-capable backends.
- Preserve existing Caplets exposure modes, Code Mode handles, progressive wrappers, native service behavior, and CLI inspection/call surfaces.

## Non-Goals

- Do not depend on hosted APIs.guru specs or a third-party Discovery-to-OpenAPI converter.
- Do not persist resumable upload sessions across separate Caplets calls in the first version.
- Do not auto-confirm destructive operations inside Caplets. Caplets exposes safety hints; clients and agents decide how to handle them.
- Do not treat inline data URLs as the primary agent media path.

## Public Config

Top-level config uses `googleDiscoveryApis`:

```json
{
  "googleDiscoveryApis": {
    "google-drive": {
      "name": "Google Drive",
      "description": "Access and manipulate Google Drive files and folders.",
      "discoveryUrl": "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
      "auth": {
        "type": "oidc",
        "issuer": "https://accounts.google.com",
        "clientId": "$env:GOOGLE_CLIENT_ID",
        "clientSecret": "$env:GOOGLE_CLIENT_SECRET"
      }
    }
  }
}
```

Supported source fields:

- `discoveryUrl`: remote Google Discovery document URL.
- `discoveryPath`: local Google Discovery document path.
- `baseUrl`: optional request base URL override; default is inferred from the document.

Common Caplet fields match other backend families: `name`, `description`, `auth`, `tags`, `exposure`, `shadowing`, `useWhen`, `avoidWhen`, `setup`, `projectBinding`, `runtime`, `requestTimeoutMs`, `operationCacheTtlMs`, and `disabled`.

Caplet files use `googleDiscoveryApi`:

```yaml
googleDiscoveryApi:
  discoveryUrl: https://www.googleapis.com/discovery/v1/apis/drive/v3/rest
  auth:
    type: oidc
    issuer: https://accounts.google.com
```

The normalized backend discriminator is `backend: "googleDiscovery"`.

## Discovery Mapping

`GoogleDiscoveryManager` loads `discoveryUrl` or `discoveryPath`, validates that the document is a Google Discovery document, and recursively walks `resources.*.methods.*`.

Each Discovery method becomes a Caplets tool:

- tool name comes from `method.id`, such as `drive.files.list`
- HTTP method comes from `method.httpMethod`
- request path comes from `method.path`
- base URL is inferred from `baseUrl`, or `rootUrl + servicePath`, with config override support
- path/query parameters come from method parameters plus global parameters
- request body schema comes from `method.request.$ref`
- response body schema comes from `method.response.$ref`
- schemas come from top-level Discovery `schemas`, converted into the JSON Schema-like shape Caplets tools expose

The manager preserves Google-specific metadata internally, including `supportsMediaUpload`, `mediaUpload.protocols`, `supportsMediaDownload`, `parameterOrder`, and operation scopes.

## Operation Filters

Google Discovery APIs support operation filters:

```json
{
  "includeOperations": ["drive.files.*", "drive.permissions.list"],
  "excludeOperations": ["*.delete", "drive.files.emptyTrash"]
}
```

Rules:

- Operation IDs are Discovery `method.id` values.
- If `includeOperations` is absent, all operations are included.
- `excludeOperations` applies after include.
- Filtering controls tool discovery, tool execution, and inferred scopes.
- Glob matching is simple and documented; it is not regular-expression matching.

## Auth And Scope Inference

Google Discovery APIs infer OAuth scopes from the Discovery document unless `auth.scopes` overrides inference.

Rules:

- If `auth.scopes` is configured, use it exactly.
- Otherwise infer scopes from the final exposed operation set after operation filters.
- For `oidc`, include `openid profile email` plus inferred Google API scopes.
- De-duplicate and sort inferred API scopes for stable authorization URLs.
- Store the requested or granted scope string in the OAuth token bundle.
- Tool descriptors expose operation-level possible scopes as guidance.
- If config changes cause the inferred scope set to differ from the stored bundle, require re-login rather than silently calling with insufficient scopes.

The generic OAuth flow needs a way for backends to supply resolved scopes at login time; today it only reads static `auth.scopes`.

## Safety Annotations

Safety annotations mirror existing HTTP-like behavior:

- `GET` and `HEAD` operations are `readOnlyHint: true`.
- `DELETE` operations are `destructiveHint: true`.
- Known destructive non-DELETE methods also receive destructive hints using method ID and description patterns, such as `emptyTrash`.
- Caplets does not add confirmation prompts.

Broad Google APIs are still exposed by default. Users can narrow them with operation filters.

## Shared Media Artifact Contract

Media-capable backends use a shared Media artifact contract.

Small JSON and text responses remain inline. Binary responses, media downloads, and oversized text responses are written to Caplets-managed artifact storage and returned as metadata:

```json
{
  "status": 200,
  "headers": { "content-type": "application/pdf" },
  "body": {
    "artifact": {
      "path": "/Users/ianpascoe/.local/state/caplets/artifacts/google-drive/...",
      "mimeType": "application/pdf",
      "byteLength": 12345,
      "sha256": "..."
    }
  }
}
```

Default artifact storage:

```text
~/.local/state/caplets/artifacts/<caplet-id>/<call-id>/<filename>
```

Rules:

- Caller-provided `outputPath` is allowed for explicit download destinations.
- Local execution returns absolute local paths.
- Remote and hosted execution return artifact references or links, not pretend-local paths.
- Artifact metadata should also appear in `_meta.caplets.artifacts` when useful for clients.
- HTTP, OpenAPI, Google Discovery, and future media-capable backends share the infrastructure.

## Google Media Download And Upload

Downloads and exports:

- `supportsMediaDownload` methods can return inline JSON/text when appropriate or Media artifacts for binary/large content.
- Download/export tools accept optional `outputPath` and `filename`.
- Response metadata includes status, content type, byte count, hash, and artifact information.

Uploads use an agent-first media input contract:

```json
{
  "body": { "name": "report.pdf" },
  "media": { "path": "/abs/path/report.pdf", "mimeType": "application/pdf" }
}
```

Supported media sources, in priority order:

- `media.path`: primary for local coding agents.
- `media.artifact`: primary for chaining prior Caplets media outputs into uploads.
- `media.dataUrl`: supported only as a small-input fallback.

Rules:

- Exactly one of `path`, `artifact`, or `dataUrl` is accepted.
- Raw `dataUrl` content must not be echoed in output, logs, errors, or descriptors.
- Max decoded or input size is enforced.
- MIME type is inferred from file, artifact, or data URL when possible; explicit `mimeType` can override inference.

Google upload protocols:

- simple upload for media-only requests
- multipart upload for metadata plus media
- resumable upload for large files or when selected by protocol/defaults

Resumable uploads are internal to one Caplets call. The backend may retry transient chunk failures within that call, but v1 does not expose persisted resumable session resume or cancel commands.

## CLI And Docs

CLI additions:

- `caplets add google-discovery <id> --discovery-url <url>`
- optional parity form: `--discovery <path-or-url>`
- existing `list`, `inspect`, `list-tools`, `get-tool`, `call-tool`, `auth login`, and Code Mode surfaces work with the new backend

Docs updates:

- configuration reference for `googleDiscoveryApis`
- Caplet file reference for `googleDiscoveryApi`
- capabilities docs for Google Discovery API backends
- media artifact documentation shared across HTTP-like backends
- ADR for path/artifact-based media result handling

## Verification

Implementation should include:

- unit tests for Discovery parsing, schema conversion, operation filtering, scope inference, and request construction
- tests for media artifact writing and inline-vs-artifact response selection
- tests for simple, multipart, and single-call resumable upload behavior using local fixtures
- CLI tests for add/list/get/call/auth URL behavior
- schema generation and schema checks after config changes
- focused tests first, then `pnpm verify` once implementation is complete
