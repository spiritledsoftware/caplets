# Plan 022: Remove Legacy Caplets Cloud

> Status: COMPLETE
> Planned against: `ac12a174`
> Direction: delete the legacy hosted Caplets Cloud product without narrowing generic Current Host remote support
> Priority: P0
> Impact: HIGH
> Effort: XL
> Fix risk: HIGH
> Depends on: Plans 000 and 020

## Why this matters

The repository currently contains two remote products behind one set of commands and native-selection helpers: the Current Host protocol that any Caplets server can implement, and a hostname-selected Caplets Cloud product with its own login, workspaces, Vault endpoints, presence API, bundle upload, hosted runtime, setup, resource, billing, and Project Binding policies. Caplets Cloud is not part of the pre-release product. Keeping its implementation would make the first release publish unsupported commands, credentials, exported types, generated error codes, configuration fields, and runtime promises.

The deletion must not turn into a broad removal of remote operation. Current Host Remote Login, remote CLI administration, downstream MCP/Attach, the public SDK, and Project Binding are generic capabilities. They must continue to work for any origin, including an origin whose hostname was formerly recognized as Caplets Cloud. The Cloud product special case disappears; the remote seam remains.

This is also a credential migration. Current Remote Profiles use `self-hosted:` and `cloud:` identities, and the profile store can import `cloud-auth.json`. The target has one generic `remote:` identity. Existing self-hosted profile metadata and credential bytes must move together without exposing a half-migrated profile. Legacy Cloud files are not migrated, deleted, parsed, repaired, or used as generic credentials. They remain byte-for-byte untouched and unread so this release cannot accidentally consume an obsolete hosted token.

Use deep-module discipline throughout. The Remote Profile store owns origin normalization, key migration, crash recovery, credential locality, and redacted status behind one small generic interface. Callers must not learn legacy key formats or repeat migration logic. The Current Host client and Project Binding interfaces remain the test surfaces; do not replace them with Cloud-shaped adapters under new names.

## Fixed decisions

1. The Caplets Cloud **product integration** is deleted before release. There is no hosted compatibility mode, hidden flag, deprecated alias, hostname allowlist, or dormant Cloud client.
2. `cloud.caplets.dev` and `*.preview.caplets.dev` receive no special treatment. If supplied to generic remote commands, they are ordinary origins and use the same Current Host protocol as every other origin.
3. Current Host URLs are origins: `http(s)://host[:port]` only. New inputs with credentials, a non-root path, query, or fragment fail with a safe `REQUEST_INVALID` error rather than being silently reinterpreted. Origin serialization is deterministic and is the only input to profile keys.
4. Native selection retains `auto`, `local`, `daemon`, and `remote` as applicable at the existing seams. `cloud` is removed from accepted modes, environment parsing, telemetry, diagnostics, help, and types. In auto mode, the presence of any remote URL selects generic remote behavior; hostname does not select a product.
5. `CAPLETS_REMOTE_URL` remains the non-secret remote selector. Cloud-only selectors and policy inputs, including `CAPLETS_CLOUD_URL`, `CAPLETS_CLOUD_TOKEN`, `CAPLETS_CLOUD_WORKSPACE_ID`, `CAPLETS_CLOUD_AUTH_PATH`, `CAPLETS_CLOUD_TIER`, and `CAPLETS_REMOTE_WORKSPACE`, are removed from active behavior and current documentation.
6. Remote Profile metadata has one generic kind and key space. The target key is `remote:<canonical-origin>`. Do not retain a `kind: "self-hosted" | "cloud"` union, workspace selection, or Cloud credential conversion in the new interface.
7. Existing `self-hosted:` profile records and their credential files migrate automatically and atomically at the Remote Profile store seam. The migration is deterministic, lock-protected, crash-recoverable, and fail-closed on origin collisions or inconsistent files.
8. Existing Cloud state does **not** migrate. `cloud-auth.json`, `cloud:` profile records, `cloud:` credential files, and selected-workspace files are not opened, parsed, statted, chmodded, rewritten, renamed, or removed. `CAPLETS_CLOUD_AUTH_PATH` is ignored and is not used to derive the generic auth root.
9. A legacy Cloud profile never authenticates a generic remote request. A formerly special Cloud hostname requires a newly completed generic Current Host Remote Login unless a generic `remote:` profile already exists.
10. `caplets cloud ...`, Cloud browser Auth, workspace switching, Cloud bundle upload, and proprietary Cloud Vault calls are removed. Old argv fails through the ordinary unknown-command/invalid-mode path; do not print a compatibility redirect to another hosted product.
11. Generic `caplets remote login|status|logout`, remote add/install/catalog/Admin operations, `caplets attach`, native remote mode, and `--remote` Vault operations remain. They use the Current Host client/SDK adapters only.
12. The proprietary Cloud Project Binding presence/file-upload adapter is deleted. The generic SDK/WebSocket Current Host Project Binding coordinator, protocol, fingerprinting, sync filtering, lifecycle guards, and server routes remain.
13. This plan does not expand the eligibility of native Project Binding or complete the historical self-hosted HTTPS spike. It preserves whatever generic Current Host eligibility is present when implementation starts and removes only Cloud-specific branches.
14. Hosted runtime and setup taxonomy is deleted: Cloud runtime HTTP/adapter code, hosted deployment planning, hosted resource classes/policies, hosted sandbox states, hosted billing reasons, `hosted_sandbox`, and the `cloud`/`hosted_worker` setup aliases. Local and Current Host setup behavior remains.
15. Generic execution-risk checks that protect local or Current Host installation remain even if they currently use names such as `runtimeFeatures`. Remove only data and interfaces whose meaning is hosted placement, capacity, billing, or sandbox selection. Do not weaken install confirmation or executable-backend risk checks as collateral cleanup.
16. Generic helpers that are still used move out of Cloud namespaces. `findProjectRoot` moves to a neutral module and keeps its current markers and fallback behavior. Unused Cloud helpers are deleted, not relocated speculatively.
17. Cloud-specific public exports are removed in the same cutover. The `@caplets/core/runtime-plan` subpath remains, but loses hosted setup, sandbox, provider, billing, and hosted-provenance contracts; its generic local/remote Current Host route classification, feature inference, resource planning, and install-safety surface remain. There are no re-exports or deprecated type aliases for removed hosted symbols. Generic `caplet-source`, native, Project Binding, and SDK package subpaths remain.
18. Canonical config and OpenAPI sources change first; generated config schema, OpenAPI, and SDK artifacts are regenerated. Generated files are never hand-edited.
19. Current product, architecture, CLI, integration, Vault, troubleshooting, and reference docs describe local/daemon/generic remote operation only. Dated plans, ADRs, and changelogs remain historical records and are not rewritten to pretend Cloud never existed.
20. Cloudflare Workers, the `caplets/cloudflare` catalog Caplet, Alchemy, Wrangler, deployment workflows, catalog deployment adapters, and preview/domain infrastructure are unrelated deployment technology and remain in scope for normal verification, not deletion.
21. There is no feature flag or mixed release. Ship and roll back the source, generated artifacts, docs, and release metadata as one unit.

## Scope

### In scope

- Deletion of the legacy Cloud CLI, Auth client/store/types, workspace selection, Cloud bundle upload, Cloud Vault adapter, hosted runtime adapter/HTTP app, presence client, project upload/sync helpers, and Cloud-only tests
- Collapse of remote/native/Attach selection to generic Current Host behavior for every origin
- Generic Remote Profile types, methods, keys, status, refresh, logout, and redacted diagnostics
- Atomic `self-hosted:` record-plus-credential migration to `remote:` keys
- Explicit non-observation and byte preservation of all legacy Cloud credential/profile/selection files
- Removal of Cloud-only Project Binding errors, tier/billing/workspace taxonomy, presence behavior, and generated protocol artifacts
- Preservation of the generic SDK/WebSocket Project Binding coordinator and Current Host server implementation
- Removal of hosted setup, sandbox, provider, billing, and provenance contracts from runtime planning while preserving generic local/remote route, feature, and resource planning
- Relocation of `findProjectRoot` to a neutral module
- Cloud values removed from telemetry, doctor output, setup help, native options, and observed-output scope taxonomy
- Root/package export cleanup and dependency/lockfile cleanup when a dependency becomes genuinely unused
- Regeneration of `schemas/caplets-config.schema.json`, `schemas/caplets-http.openapi.json`, and `packages/sdk/src/generated/`
- Current docs and the existing unreleased changeset updated for the clean cutover
- Focused migration, CLI, native, Project Binding, generated-contract, build, and full-repository verification

### Out of scope

- Removing or renaming Cloudflare, Workers, Wrangler, Alchemy, preview deploys, domain infrastructure, or `caplets/cloudflare`
- Removing generic remote/downstream MCP, Attach, Current Host Admin, Remote Login, Remote Vault, SDK, or Project Binding support
- Implementing a new hosted product, hosted control plane, workspace model, billing model, sandbox provider, or compatibility server
- Importing, revoking, deleting, validating, refreshing, or otherwise observing legacy Cloud credentials
- Treating a former Cloud hostname as blocked or privileged; it is an ordinary remote origin
- Expanding self-hosted HTTPS native Project Binding beyond the behavior present at implementation start
- Changing Project Binding protocol versions or its authoritative Host State beyond removal of Cloud-only error variants
- Weakening generic install risk, Vault secrecy, auth refresh, Project Binding lifecycle, or sync safety invariants
- Changing the final public HTTP route topology; Plan 023 owns that later cutover
- Rewriting dated plans, ADRs, release changelogs, or completed implementation records
- Editing generated artifacts by hand

## Precise deletion and preservation boundary

| Area             | Delete                                                                                                                                                                         | Preserve / deepen                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI              | `caplets cloud auth *`, `caplets cloud add`, Cloud branches in remote login/status/logout, Cloud Vault dispatch, workspace options                                             | Generic Remote Login/status/logout, Current Host commands, remote add/catalog/Admin/Vault, Attach, backend OAuth commands                              |
| Auth             | `packages/core/src/cloud-auth/**`, Cloud scopes/recovery/store, legacy Cloud import                                                                                            | Current Host pending Remote Login, refresh/revoke semantics, redacted generic Remote Profile status                                                    |
| Cloud client     | `packages/core/src/cloud/{client,presence,runtime-adapter,runtime-http,sync,apply}.ts`                                                                                         | Current Host SDK/CLI adapters and `packages/core/src/project-binding/**` generic protocol modules                                                      |
| Helpers          | Cloud-namespaced `project-root.ts` path                                                                                                                                        | Same `findProjectRoot` behavior relocated to a neutral module; existing SDK fingerprint helper                                                         |
| Remote model     | Cloud/self-hosted kind split, workspace keys/selections, host classifier, hosted route construction                                                                            | One origin-based remote resolver, one profile status, one refresh path, one Current Host endpoint family                                               |
| Native           | `cloud` mode, Cloud env/options, hosted selection, Cloud presence composition                                                                                                  | local, daemon, generic remote, local overlay, generic remote client, existing Current Host Project Binding adapter                                     |
| Project Binding  | proprietary presence endpoints/file upload, Cloud tier/workspace/billing/Auth errors                                                                                           | public SDK coordinator, WebSocket endpoint, server routes, lifecycle cancellation/lease guards, fingerprint/sync filters                               |
| Runtime/setup    | hosted deployment defaults, hosted setup/sandbox/provider/provenance states, hosted resource aliases/policies, `hosted_sandbox`, and the `cloud`/`hosted_worker` setup aliases | generic local/remote runtime route classification, feature inference, resource planning, install-safety metadata, and `local_host`/`remote_host` setup |
| Config/contracts | Cloud protocol enums and hosted-only planner defaults or accepted values                                                                                                       | ordinary Caplet config including `runtime.features` and `runtime.resources.class`, project-binding requirement, setup config, Current Host OpenAPI/SDK |
| Distribution     | Cloud public root exports and hosted-only symbols/defaults in `./runtime-plan`                                                                                                 | `@caplets/core`, generic `@caplets/core/runtime-plan`, `@caplets/core/native`, caplet-source, Project Binding, `@caplets/sdk` public seams             |
| Infrastructure   | nothing                                                                                                                                                                        | `alchemy.run.ts`, `infra/**`, deploy/preview workflows, Cloudflare catalog/runtime adapters and dependencies                                           |
| History          | nothing                                                                                                                                                                        | dated plans, ADRs, changelogs, and release history verbatim                                                                                            |

The deletion test applies: removing the hosted modules must make hosted complexity vanish. If workspace, Cloud scopes, hosted capacity, or Cloud hostname decisions reappear across generic callers, the implementation has renamed a shallow Cloud adapter instead of deleting the product.

## Evidence-backed current seams and drift checks

Before implementation, change this plan to `IN PROGRESS`, record `git rev-parse --short HEAD`, and confirm the following current seams still exist.

### Cloud-owned seams to remove

- `packages/core/src/cloud-auth/`
  - `CloudAuthClient`, `CloudAuthStore`, Cloud login/token/workspace types, recovery mapping, `CAPLETS_CLOUD_AUTH_PATH`, and browser-open helper
- `packages/core/src/cloud/`
  - proprietary `CapletsCloudClient` Project Binding/Vault methods
  - `ProjectBindingSessionManager` presence lifecycle
  - `createCloudRuntimeAdapter` and `createRuntimeHttpApp`
  - project file upload/sync, apply receipt, and other unused hosted helpers
  - `findProjectRoot`, which is the one proven generic helper to relocate
- `packages/core/src/cli.ts`
  - imports for Cloud Auth/client/bundling
  - Cloud telemetry mode
  - Cloud login, selection, refresh, CLI registration, and output projections
  - `caplets cloud auth ...` and `caplets cloud add`
  - `VaultRemoteTarget` Cloud branch and direct Cloud Vault calls
- `packages/core/src/cli/cloud-add.ts`
  - hosted bundle construction and size policy
- `packages/core/src/remote/options.ts`
  - `CapletsRemoteMode` value `cloud`, `resolveHostedCloudRemote`, `hostedCloudWorkspaceFromRemoteUrl`, `isCapletsCloudUrl`, `/v1/ws/:workspace` route shaping, and workspace input
- `packages/core/src/remote/profiles.ts` and `profile-store.ts`
  - `RemoteProfileKind`, `cloud:` and `self-hosted:` key split, selected workspace records, Cloud save/get/list/logout/refresh methods, `CloudAuthStore` construction/import, and directory-wide parsing that currently opens Cloud records
- `packages/core/src/remote/selection.ts`
  - `hosted_cloud` selection, Cloud scope/refresh/workspace handling, and Cloud presence projection
- `packages/core/src/native/options.ts`, `native/service.ts`, `native/remote.ts`, and `attach/server.ts`
  - Cloud mode/options/env, hosted profile-backed branch, proprietary presence/session manager composition, Cloud project file upload, and Cloud telemetry
- `packages/core/src/project-binding/attach.ts`, `sync-size.ts`, and `errors.ts`
  - hosted auth mode, selected workspace, `CAPLETS_CLOUD_TIER`, free/plus/pro/enterprise tier selection, Cloud/workspace/billing/subscription error variants, and upgrade-plan recovery copy
- `packages/core/src/runtime-plan/`
  - public hosted route/resource/feature/placement taxonomy and the hosted/default deployment planner
- `packages/core/src/setup/types.ts`, `cli/setup.ts`, and `cli/setup-caplet.ts`
  - `hosted_sandbox`, `cloud`, and `hosted_worker` targets and their error/help text
- `packages/core/src/config.ts`, `config-runtime.ts`, and `caplet-files-bundle.ts`
  - hosted-only runtime defaults or accepted values mixed with generic runtime requirement schemas; preserve `runtime.features` and `runtime.resources.class`
- `packages/core/src/caplet-source/parse.ts`
  - forced `{ deployment: "hosted" }` planning and hosted setup-target selection in an otherwise generic public runtime projection
- `packages/core/src/index.ts`, `packages/core/src/runtime-plan/**`, `packages/core/package.json`, and `packages/core/rolldown.config.ts`
  - Cloud Auth root exports and hosted symbols/defaults mixed into the public `runtime-plan` subpath and root type surface
- telemetry and cache modules
  - accepted `cloud` runtime values and the observed-output `cloud` scope

### Generic seams that must survive

- `packages/core/src/cli.ts`
  - the Current Host `RemoteCliCommandAdapter`/migration adapter and generic remote add/Admin/Vault dispatch
  - Current Host pending Remote Login and token refresh/revoke behavior
- `packages/core/src/remote/selection.ts`
  - current generic remote credential refresh and local-daemon fallback
- `packages/core/src/native/service.ts`
  - remote client/local overlay composition and the generic `RemoteProjectBindingSessionManager`
- `packages/core/src/project-binding/**`
  - SDK/WebSocket Attach, server routes, workspace filesystem management, lifecycle, sync filtering, Mutagen adapter, and security errors that are not hosted-product policy
- `packages/core/src/caplet-source/**`
  - bundle/filesystem source parsing and stable runtime fingerprinting used by Current Host storage/install; only the hosted projection is removed
- `packages/core/src/install.ts`, lockfile/storage/Admin projections
  - generic executable-backend risk detection and confirmation
- `packages/sdk`
  - generated Current Host client, Project Binding coordinator, and Node fingerprint entrypoint
- Plan 000/020 Current Host routes, OpenAPI ownership, generated SDK, and consumer migrations

### Infrastructure that must remain untouched except for verification fallout

- `alchemy.run.ts`
- `infra/**`
- `.github/workflows/deploy.yml`
- `.github/workflows/pr-preview-deploy.yml`
- `apps/catalog/src/cloudflare-dev-middleware.ts`
- `apps/catalog/src/cloudflare-workers-dev.ts`
- `caplets/cloudflare/**`
- root/package Alchemy, Wrangler, and Cloudflare dependencies and scripts

Run the inventory before changing code:

```sh
rg -n 'Caplets Cloud|CloudAuth|CapletsCloud|hosted_cloud|hosted_sandbox|hosted_worker|CAPLETS_CLOUD|cloud_auth_|workspace_switch_required|billing_required|subscription_past_due' packages apps schemas docs README.md CONTEXT.md .changeset
rg -n 'isCapletsCloudUrl|resolveHostedCloudRemote|cloud:|self-hosted:|selectedWorkspace' packages/core/src packages/core/test
rg -n 'findProjectRoot' packages/core/src packages/core/test
rg -n 'RemoteCliCommandAdapter|RemoteProjectBindingSessionManager|runProjectBindingSession|project-bindings/connect' packages/core/src packages/sdk/src packages/core/test packages/sdk/test
rg -n 'cloudflare|Cloudflare|alchemy|wrangler' package.json pnpm-lock.yaml alchemy.run.ts infra apps caplets .github/workflows
pnpm schema:check
pnpm openapi:check
```

Stop and mark the plan `STALE` if Cloud selection no longer exists, profiles no longer use the cited key split, generic Current Host Remote Login/Project Binding has been removed, canonical generated artifact ownership has moved, or deployment infrastructure no longer matches the preservation list. Refresh the plan rather than guessing around drift.

## Target remote model

### Origin contract

Introduce one neutral origin parser used by CLI, native selection, Remote Profile keys, doctor output, and endpoint construction.

For new configuration and command inputs:

- accept only `http:` and `https:`;
- reject embedded username/password;
- reject non-root pathname, query, and fragment;
- normalize hostname casing and default ports through `URL`;
- serialize exactly one canonical origin representation and test IPv4, IPv6, localhost, explicit ports, and HTTPS;
- never branch on hostname;
- never append a workspace prefix.

The remote resolver derives the then-current Current Host MCP, Attach, Admin/health, and Project Binding locations from that origin in one module. Plan 023 will later replace those route suffixes; callers must consume the resolver rather than hard-code them so that cutover remains local.

### Remote Profile interface

Replace Cloud/self-hosted method pairs with one deep interface, equivalent to:

```ts
type RemoteProfileStatus = {
  authenticated: boolean;
  key: string;
  origin: string;
  hostIdentity?: string;
  clientId?: string;
  selected: boolean;
  clientLabel?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  scope?: string[];
  tokenType?: string;
};

interface RemoteProfileStore {
  saveRemoteProfile(input: SaveRemoteProfileInput): Promise<RemoteProfileStatus>;
  getRemoteProfileStatus(input: {
    origin: string;
    hostIdentity?: string;
  }): Promise<RemoteProfileStatus | undefined>;
  refreshRemoteProfileIfNeeded(
    input: RefreshRemoteProfileInput,
  ): Promise<RemoteProfileWithCredential | undefined>;
  logoutRemoteProfile(input: { origin: string; hostIdentity?: string }): Promise<boolean>;
  listRemoteProfileStatuses(): Promise<RemoteProfileStatus[]>;
}
```

Exact names may follow local convention, but preserve these invariants:

- Callers know only origins and generic profile operations.
- Credential loading stays behind the store seam where feasible; status never contains access/refresh tokens, client secrets, or pairing material.
- Host identity mismatch remains fail-closed.
- Refresh remains single-flight per generic remote key and rechecks under the mutation lock before commit.
- A generic profile key is `remote:<canonical-origin>`.
- Stored generic metadata uses a new explicit version and contains no Cloud/workspace fields.
- `selected` may remain only if generic selection truly uses it; otherwise remove the redundant field rather than hard-code `false`.
- No caller examines legacy filenames, key prefixes, or migration state.

### Current Host adapters

Collapse selection and dispatch onto the generic remote path:

- `caplets remote login <origin>` always runs Current Host pending Remote Login.
- status, refresh, logout/revoke, Attach, doctor, native remote, Admin operations, add/catalog operations, and Vault use the same profile and resolver.
- `--remote` Vault always uses the Current Host command/SDK adapter; there is no direct workspace Vault endpoint.
- any former Cloud hostname follows the same requests and failures as `https://caplets.example.com`.
- generic remote errors retain stable safe codes such as `remote_credentials_required`, `remote_credentials_revoked`, `remote_auth_failed`, endpoint/sync/lease/policy failures, and no secret-bearing details.

## Atomic self-hosted profile migration

### Legacy inputs

Only these files are migration inputs:

```text
<auth-root>/remote-profiles/profiles/<encodeURIComponent("self-hosted:" + legacy-url)>.json
<auth-root>/remote-profiles/credentials/<encodeURIComponent("self-hosted:" + legacy-url)>.json
```

Discover candidates by decoding the filename and checking the `self-hosted:` prefix **before opening the file**. Do not open every JSON file and inspect its `kind`. This prefix-first rule is what quarantines `cloud:` records.

The migration is lazy at store initialization/first operation and runs under the existing global Remote Profile mutation lock. Every process performs crash recovery before reading a generic profile.

The mutation lock is a cross-process correctness boundary, not only an in-process queue. Before relying on it for migration, replace the current mtime-only stale-directory takeover with owner-checked lease semantics: write an unpredictable owner token and process identity, renew the lease while work is active, reclaim only an expired lease whose owner is proven dead, and verify the token before release. If owner liveness or ownership cannot be proven, time out and fail closed. A contender must never remove a live owner's lock. Test contention, a holder paused beyond the old timeout, owner-token mismatch, crashed-owner reclamation, and restart recovery. Apply the same ownership rule to generic refresh locks so migration, refresh, save, and logout cannot commit across one another.

### Canonicalization and collision policy

For each legacy self-hosted record:

1. Parse and validate the legacy record without logging raw content.
2. Convert its legacy `hostUrl` to the canonical origin. A legacy path is accepted only as migration input and collapses to its origin; new user inputs with paths remain invalid.
3. Derive the new key `remote:<origin>` and deterministic new profile/credential paths.
4. Group candidates by origin before committing any candidate in that group.
5. If more than one distinct legacy profile collapses to one origin, fail closed with a safe collision diagnostic and leave every file unchanged. Do not choose newest, merge tokens, or overwrite.
6. If a generic destination exists, accept it only as an idempotent previously committed migration when identity metadata matches and credential bytes match. Otherwise fail closed and leave both sides unchanged.
7. A malformed record, missing credential, symlink, non-regular file, or permission failure aborts that candidate without deleting either side. Error output identifies the origin/key safely, never file contents or tokens.

### Commit protocol

Treat the new profile record as the visibility commit point. Readers always resolve profile metadata before credentials.

1. Read the legacy credential exactly once as raw bytes after validating it is a regular non-symlink file with the expected restrictive location. Do not JSON round-trip secret bytes during migration.
2. Create same-directory temporary destination files with exclusive creation and mode `0600` beneath directories held at `0700`.
3. Write the raw credential bytes to the destination credential temp, flush it, and atomically rename it to the new credential key.
4. Build the versioned generic profile record, preserving `hostIdentity`, `clientId`, label, `createdAt`, and `updatedAt` unless the format explicitly requires a migration timestamp separate from those fields. Write, flush, and atomically rename it to the new profile key. This rename is the commit point.
5. Flush containing directories where the platform supports it.
6. Re-read through the normal generic store interface and verify metadata identity plus credential-byte equivalence without exposing the value.
7. Only after verification, delete the legacy self-hosted profile and credential. Cleanup is idempotent.
8. Remove orphan temporary files owned by the current migration. Never glob-delete unknown files.

Crash recovery is deterministic:

- New credential but no new profile means pre-commit. If bytes equal the legacy credential, retry the profile commit; otherwise fail closed.
- New profile and new credential means committed; the new key wins and recovery completes legacy cleanup.
- New profile without a new credential is corrupt and fails closed; it must never report `authenticated: true`.
- Both old and new pairs after a crash are not two active profiles. The verified new pair is authoritative and cleanup resumes under lock.
- A retry performs no network request and does not rotate credentials.

Inject failures before and after each write, flush, rename, verification, and delete. Every observed state must be either the complete old profile or the complete new profile, never metadata paired with the wrong credential.

### Legacy Cloud state quarantine

The following are historical Cloud state, not migration inputs:

```text
<CAPLETS_CLOUD_AUTH_PATH, if set>
<auth-root>/cloud-auth.json
<auth-root>/remote-profiles/profiles/<encoded cloud:* record>
<auth-root>/remote-profiles/credentials/<encoded cloud:* credential>
<auth-root>/remote-profiles/selections/<encoded cloud:* selection>
```

Required behavior:

- do not instantiate `CloudAuthStore`;
- do not use `CAPLETS_CLOUD_AUTH_PATH` to find the generic auth root;
- do not `exists`, stat, open, read, parse, chmod, write, rename, or remove any listed file;
- directory enumeration may see an entry name, but prefix filtering must exclude it before file access;
- invalid JSON, unreadable permissions, dangling symlinks, and arbitrary bytes in Cloud files cannot break generic remote status/list/login/refresh/logout;
- snapshot bytes, modes, mtimes, and filenames before and after a full generic remote scenario and assert equality;
- instrument filesystem access in a focused test so any attempted file operation on a Cloud path fails the test;
- generic login to a former Cloud hostname does not consult these files and reports login-required until Current Host login succeeds.

This guarantee is stronger than “do not delete.” It prevents obsolete hosted credentials from influencing generic authority.

## Runtime planning and setup removal contract

Keep the generic `runtime-plan` Module and public package subpath. Remove hosted setup, sandbox, provider-capacity, billing, and hosted-call/route-provenance types; the implicit hosted deployment default; and hosted-only reason codes. Narrow deployment to `local | remote`, setup targets to `local_host | remote_host`, and rename hosted-prefixed resource types that remain genuinely generic. Preserve route classification, feature inference/provenance, resource resolution, and the public planners because `caplet-source`, installation review, and executable-backend safety consume them.

Retain `caplet-source` parsing, declared-input fingerprinting, bundle validation, filesystem sources, and its runtime projection. Replace the forced `{ deployment: "hosted" }` call with the generic remote-host target where a caller needs remote planning; do not erase route, feature, resource, or setup-risk output.

Preserve canonical `runtime.features` and `runtime.resources.class` configuration: those fields describe executable requirements and feed generic safety/resource planning. Remove only hosted-only accepted values, defaults, policy inputs, or unknown passthrough fields. Do not weaken install confirmation or executable-backend risk inference.

Narrow setup targets to `local_host | remote_host`. Update parsers, local/SQL setup-state validation, CLI target aliases/help, and tests. Existing generic local/remote setup rows remain readable. Historical `hosted_sandbox` rows are inert history: do not execute them, coerce them to `remote_host`, or add a database migration that deletes unrelated rows. If a current store enumerates such a row, omit it with an explicit safe compatibility diagnostic or fail the specific lookup; do not make normal Current Host startup execute it.

Remove Cloud tier selection from Project Binding preflight. Use the existing generic Current Host limit/policy seam and neutral recovery text. Preserve manifest filtering, file-size enforcement, Mutagen lifecycle, and server-owned policy. Do not turn removal of free/plus/pro/enterprise names into unbounded sync.

## Public exports, dependencies, and generated contracts

### `@caplets/core`

Remove from the root and package map:

- `CloudAuthClient`, `CloudAuthStore`, `cloudAuthPath`, redacted Cloud status, Cloud credential/login/workspace types, and `openBrowserUrl` when it has no generic caller;
- hosted-only runtime-plan types, defaults, and root exports while retaining the generic `./runtime-plan` export/build entry;
- any Cloud-native option types or `cloud` mode union members.

Keep generic caplet-source, native, catalog, config-runtime, Project Binding, redaction, and stable-json exports. A consumer compile test must prove the supported surfaces still import. Do not add aliases for removed exports.

### Dependencies

After source deletion, inspect root and package manifests plus `pnpm-lock.yaml`. Remove only packages/scripts whose last production and build caller was deleted. Do **not** remove Alchemy, Wrangler, Cloudflare, `@caplets/sdk`, WebSocket, Hono, or Project Binding dependencies merely because their names or protocols overlap Cloud code. Lockfile changes must be the consequence of manifest changes, not manual pruning.

### Schemas and SDK

Update canonical sources, then regenerate:

- `schemas/caplets-config.schema.json` no longer advertises hosted runtime resources;
- Project Binding protocol/OpenAPI error enums no longer include Cloud Auth, workspace switching, billing, subscription, usage-plan, or email-verification hosted policy codes;
- generic remote credential, endpoint, sync, lease, and policy codes remain;
- `schemas/caplets-http.openapi.json` and `packages/sdk/src/generated/` match the canonical route-local definitions;
- `packages/sdk` Project Binding session parsing accepts the surviving generic codes and remains exhaustive;
- no generated operation, schema, or type contains a Cloud workspace URL or credential concept.

Plan 023 owns the later route rename. Do not pre-apply its route topology while regenerating in this plan.

## Documentation and release metadata

After behavior and generated artifacts pass:

1. Update `README.md` and its published CLI-package mirror so remote examples use origins, generic `CAPLETS_MODE=remote`, and no Cloud commands.
2. Update `CONTEXT.md` and `docs/architecture.md` to describe one generic Current Host remote/Project Binding adapter. Remove the claim that Cloud and self-hosted are distinct adapters.
3. Update current product docs including `docs/product/caplets-code-mode-prd.md`, `docs/product/caplets-vault.md`, and `docs/product/telemetry-readout.md`.
4. Update current docs-site pages including agent integrations, Remote Attach, Project Binding, Vault, troubleshooting, SDK wording, and CLI reference.
5. Update `packages/opencode/README.md` and `packages/pi/README.md` to list local/daemon/remote only.
6. Remove Cloud-only config/env/help tables and workspace/billing recovery guidance.
7. Preserve Cloudflare/Alchemy documentation and examples that describe deployment technology.
8. Preserve dated plans, ADRs, and changelog entries exactly as history. The plan index may mark supersession/dependency facts, but historical body text is not rewritten.
9. Update the existing unreleased `.changeset/current-host-admin-api.md` rather than creating a competing pre-release story. Add `@caplets/opencode` and `@caplets/pi` release entries if their published selection behavior changes, and explicitly state that legacy Cloud commands/modes/exports were removed while generic remote remains.
10. Mark this plan complete only after the completion notes contain focused, smoke, generated-artifact, docs, changeset, and review evidence.

A final current-doc inventory may contain `Cloudflare`, historical plan/ADR/changelog references, and this plan. It must not contain live instructions for Caplets Cloud, `CAPLETS_MODE=cloud`, Cloud workspaces, hosted sandbox targets, or Cloud Vault/Auth commands.

## Vertical implementation slices

Follow red-green TDD at the Remote Profile, CLI, native selection, Project Binding, config, and package interfaces. A slice is complete only when its observable behavior works; do not first delete every file and repair the repository afterward.

### 1. Freeze the preservation and non-observation contract

Add failing coverage before deletion for:

- generic Remote Login/status/logout/refresh against an arbitrary origin;
- generic remote add/Admin/Vault dispatch through the Current Host adapter;
- generic Attach and SDK/WebSocket Project Binding behavior;
- a former Cloud hostname taking the exact same generic path;
- Cloud files containing invalid/unreadable arbitrary bytes that are never accessed or changed;
- Alchemy/Cloudflare build/import smoke remaining green.

Record byte/mode/mtime snapshots for Cloud fixtures and an access spy that throws on any forbidden file operation. Keep these tests after Cloud-specific behavior tests are removed.

Run:

```sh
pnpm --filter @caplets/core test -- \
  test/remote-login-cli.test.ts \
  test/remote-selection.test.ts \
  test/remote-cli-client.test.ts \
  test/native-remote.test.ts \
  test/attach-cli.test.ts \
  test/project-binding-integration.test.ts
pnpm --filter @caplets/sdk test
```

### 2. Deepen the generic Remote Profile store and migrate self-hosted keys

Add table-driven and fault-injection tests for origin parsing, v2 metadata, raw credential-byte preservation, identity mismatch, path-to-origin migration, collisions, idempotent restart, every commit interruption, refresh single-flight, logout, and Cloud file quarantine.

Implement the generic interface and deterministic commit protocol under the existing mutation/refresh locks. Update Current Host login/selection callers to use it. Delete Cloud store construction/import and selected-workspace operations only after non-observation tests fail against the old implementation and pass against the new one.

Run:

```sh
pnpm --filter @caplets/core test -- \
  test/remote-profiles.test.ts \
  test/remote-options.test.ts \
  test/remote-selection.test.ts \
  test/remote-login-cli.test.ts \
  test/cloud-auth-refresh-attach.test.ts
pnpm --filter @caplets/core typecheck
```

The last test file is expected to be replaced by generic refresh/migration coverage and then deleted; do not retain its Cloud fixtures or filename.

### 3. Cut CLI, Vault, Attach, doctor, and telemetry to generic remote

Make Cloud argv/mode tests fail first, then:

- remove Cloud command registration, imports, login/workspace/bundle helpers, and `cli/cloud-add.ts`;
- collapse remote login/status/logout and Vault to Current Host behavior;
- remove workspace options and Cloud environment variables;
- update doctor and telemetry to generic remote labels;
- relocate `findProjectRoot` and its test to a neutral path;
- ensure `caplets auth` backend-OAuth behavior is not removed with Cloud Auth.

Delete behavior tests whose subject no longer exists. Convert mixed Cloud/self-hosted tests into stronger generic-origin tests rather than mechanically deleting all remote coverage.

Run:

```sh
pnpm --filter @caplets/core test -- \
  test/cli-remote.test.ts \
  test/remote-login-cli.test.ts \
  test/remote-cli-admin.test.ts \
  test/remote-cli-bundle.test.ts \
  test/remote-cli-public-auth.test.ts \
  test/doctor-cli.test.ts \
  test/attach-cli.test.ts \
  test/project-root.test.ts
pnpm --filter @caplets/core typecheck
pnpm --filter caplets build
```

### 4. Remove proprietary native/Project Binding Cloud adapters

Add failing generic native/Attach cases that prove remote profile resolution, token refresh, Project Binding start/update/close, cancellation, unsupported-endpoint behavior, and local overlay still work for arbitrary origins.

Delete hosted selection, Cloud presence/file upload, Cloud tier/workspace branches, and Cloud-only error variants. Preserve `RemoteProjectBindingSessionManager`, SDK coordinator usage, server routes, lease/state guards, sync filters, fixed generic bounds, and current eligibility policy. Rename or delete Cloud-named tests based on the behavior they protect; for example, redundant `cloud-mutagen.test.ts` must not cause deletion of the generic `project-binding-mutagen.test.ts` suite.

Run:

```sh
pnpm --filter @caplets/core test -- \
  test/native-options.test.ts \
  test/native-remote.test.ts \
  test/attach-service-wiring.test.ts \
  test/attach-cli.test.ts \
  test/project-binding-protocol.test.ts \
  test/project-binding-routes.test.ts \
  test/project-binding-integration.test.ts \
  test/project-binding-mutagen.test.ts \
  test/project-binding-sync-filter.test.ts \
  test/project-binding-sync-size.test.ts
pnpm --filter @caplets/sdk test
pnpm --filter @caplets/core typecheck
```

### 5. Delete hosted runtime/setup/config taxonomy

Add failing contract cases for rejected hosted fields/targets and retained generic runtime planning plus local/remote-host setup. Then delete the Cloud runtime HTTP/adapter, remove hosted types/defaults from runtime-plan, replace caplet-source's forced hosted target with generic remote planning, narrow setup targets, and preserve generic install-risk and resource-planning behavior.

Delete Cloud-only runtime/planner tests. Update bundle/source/setup/storage tests to assert the smaller real interface, not absence through source-text snapshots.

Run:

```sh
pnpm --filter @caplets/core test -- \
  test/caplet-source.test.ts \
  test/caplet-files.test.ts \
  test/config.test.ts \
  test/setup-runner.test.ts \
  test/setup-state-storage.test.ts \
  test/install.test.ts \
  test/lockfile.test.ts \
  test/package-boundaries.test.ts
pnpm schema:generate
pnpm schema:check
pnpm --filter @caplets/core typecheck
```

### 6. Remove exports and refresh public artifacts

Remove Cloud/runtime-plan entries from the root index, package exports, and build inputs. Add consumer compile/import coverage for every preserved package subpath. Update canonical Project Binding schemas, regenerate OpenAPI/SDK, and inspect the diff for accidental route changes or generic-code loss.

Audit manifests after deletion. Preserve infrastructure dependencies. Remove an orphan only with a zero-caller inventory and successful clean build.

Run:

```sh
pnpm openapi:generate
pnpm openapi:check
pnpm --filter @caplets/core build
pnpm --filter @caplets/core test -- test/package-boundaries.test.ts test/project-binding-protocol.test.ts
pnpm --filter @caplets/sdk build
pnpm --filter @caplets/sdk test
pnpm --filter @caplets/opencode test
pnpm --filter @caplets/pi test
pnpm typecheck
```

### 7. Update current docs and release metadata

Apply the documentation/changeset contract only after runtime and generated artifacts are green. Run the final inventory with explicit historical/deployment exclusions. Do not “clean up” old plans or changelog entries.

Run:

```sh
pnpm docs:check
pnpm changeset status --since=origin/main
rg -n 'Caplets Cloud|CAPLETS_MODE=cloud|CAPLETS_CLOUD_|hosted_sandbox|hosted_worker|caplets cloud|cloud_auth_|workspace_switch_required' \
  README.md CONTEXT.md packages apps/docs/src/content/docs docs/product docs/architecture.md schemas packages/core/src packages/sdk/src
rg -n 'Cloudflare|cloudflare|alchemy|wrangler' package.json pnpm-lock.yaml alchemy.run.ts infra apps caplets .github/workflows
```

Review every remaining hit. Allowed hits need a named reason: Cloudflare/Alchemy deployment, immutable historical material outside the current-doc scope, this plan, or an unrelated third-party term such as a Google OAuth scope. A generic product/runtime hit is a failure.

## Behavior and verification scenarios

### Generic origin matrix

For each of `https://caplets.example.com`, `https://cloud.caplets.dev`, `http://127.0.0.1:5387`, and an IPv6 loopback origin:

1. With no generic profile, remote status is unauthenticated and Attach/native remote returns the generic login-required recovery.
2. Remote Login calls the Current Host pending-login endpoints; no request contains `/api/cloud-client`, `/api/workspaces`, or `/v1/ws/`.
3. Successful login stores one redacted `remote:<origin>` profile and separate credential.
4. Status, refresh, Attach, Admin, Vault, and logout use the same profile.
5. Logout/revoke removes generic authority; the next request is login-required.
6. Hostname does not change route construction, error codes, or output shape.

Reject new values such as `https://host/prefix`, `https://user:pass@host`, `https://host?workspace=x`, `https://host/#fragment`, `file:///tmp/x`, and malformed URLs before filesystem or network access.

### Migration matrix

Cover:

- one canonical-origin legacy self-hosted profile;
- a legacy path-based profile collapsing to its origin;
- expired credentials that refresh only after migration commits;
- host identity mismatch;
- missing/malformed profile or credential;
- two old paths collapsing to one origin;
- conflicting pre-existing generic destination;
- idempotent committed destination plus leftover old pair;
- injected crash/failure at every commit boundary;
- concurrent processes contending on the mutation/refresh locks;
- logout after migration, proving deleted authority cannot be resurrected from an old key.

Assert exact metadata preservation, raw credential byte equality, restrictive modes, no secret output, and only one active profile at every observable point.

### Cloud-state quarantine matrix

Create legacy Cloud files with valid secrets, invalid JSON, zero permissions where supported, symlinks, and distinctive byte payloads. Exercise generic list/status/login/refresh/logout, doctor, Attach, native selection, and migration. Assert:

- no forbidden file operation occurred;
- bytes, filename, mode, and mtime are unchanged;
- no Cloud token appears in output, error details, telemetry, requests, or new profile storage;
- a former Cloud hostname remains unauthenticated until generic login;
- an explicitly set `CAPLETS_CLOUD_AUTH_PATH` neither changes the generic auth root nor causes file access.

### CLI/native removal matrix

- `caplets cloud`, `caplets cloud auth status`, and `caplets cloud add` fail as removed commands.
- `CAPLETS_MODE=cloud` fails with the current allowed-mode list and never aliases remote.
- `CAPLETS_MODE=remote CAPLETS_REMOTE_URL=<origin>` works for any hostname.
- `auto` plus a remote URL selects generic remote.
- Cloud-only env values alone do not select a mode or profile.
- help, completion, doctor JSON, telemetry, OpenCode, and Pi expose no Cloud/workspace option.
- backend `caplets auth` commands still work.

### Project Binding and Vault preservation

- Generic Current Host Attach opens the public SDK/WebSocket Project Binding session with the saved generic credential.
- Existing start/heartbeat/update/close ordering, abort behavior, server authorization, fingerprinting, sync filtering, size bounds, and error redaction remain green.
- Unsupported Current Host Project Binding fails through the existing generic capability path, not a Cloud error.
- Remote Vault set/get/list/grant/revoke uses the Current Host adapter and never a workspace URL.
- Local Vault remains local and never reads remote or legacy Cloud state.

### Runtime/config/package removal

- Hosted runtime fields and hosted setup targets are rejected by canonical parsers.
- `local_host` and `remote_host` setup still execute and persist under their existing safety rules.
- Generic caplet-source parsing/fingerprinting and install risk checks remain green.
- `@caplets/core/runtime-plan` still imports and exposes only generic local/remote route, feature, resource, and setup planning; removed hosted symbols are absent.
- supported root/native/caplet-source/catalog/Project Binding exports build and import.
- generated config/OpenAPI/SDK contain no hosted resource, workspace, or Cloud error taxonomy.

### Deployment preservation

Build and inspect the catalog/deployment paths. Confirm Alchemy/Cloudflare imports, workflows, and Caplet definitions are unchanged except for unavoidable lockfile formatting caused by a proven manifest removal. Do not accept a passing core suite as proof that deployment infrastructure survived.

## Verification matrix

### Focused core suites

```sh
pnpm --filter @caplets/core test -- \
  test/remote-profiles.test.ts \
  test/remote-options.test.ts \
  test/remote-selection.test.ts \
  test/remote-login-cli.test.ts \
  test/cli-remote.test.ts \
  test/remote-cli-client.test.ts \
  test/remote-cli-admin.test.ts \
  test/remote-cli-bundle.test.ts \
  test/remote-cli-public-auth.test.ts \
  test/native-options.test.ts \
  test/native-remote.test.ts \
  test/attach-cli.test.ts \
  test/attach-service-wiring.test.ts \
  test/doctor-cli.test.ts \
  test/project-binding-protocol.test.ts \
  test/project-binding-routes.test.ts \
  test/project-binding-integration.test.ts \
  test/project-binding-mutagen.test.ts \
  test/project-binding-sync-filter.test.ts \
  test/project-binding-sync-size.test.ts \
  test/caplet-source.test.ts \
  test/config.test.ts \
  test/setup-runner.test.ts \
  test/setup-state-storage.test.ts \
  test/install.test.ts \
  test/package-boundaries.test.ts
```

### Generated contracts and packages

```sh
pnpm schema:generate
pnpm schema:check
pnpm openapi:generate
pnpm openapi:check
pnpm --filter @caplets/core build
pnpm --filter @caplets/core typecheck
pnpm --filter @caplets/sdk build
pnpm --filter @caplets/sdk test
pnpm --filter @caplets/sdk typecheck
pnpm --filter caplets build
pnpm --filter @caplets/opencode test
pnpm --filter @caplets/pi test
pnpm typecheck
```

### Deployment and documentation checks

```sh
pnpm --filter @caplets/catalog build
pnpm docs:check
pnpm changeset status --since=origin/main
```

Inspect `alchemy.run.ts`, `infra/**`, deploy workflows, catalog Cloudflare adapters, `caplets/cloudflare/**`, relevant manifest entries, and the lockfile after the build. A Cloud-removal text search is not allowed to delete these by name.

### Runtime smoke

Build first, then use a temporary auth root and two Current Host origins, one with a hostname formerly recognized as Cloud:

1. Seed a legacy `self-hosted:` profile/credential pair plus several hostile legacy Cloud files.
2. Run generic status and observe one successful atomic migration.
3. Start a real Current Host and complete generic Remote Login for the second origin.
4. Exercise Attach once, a bounded Project Binding session, one read-only Admin/SDK call, and a remote Vault metadata call.
5. Restart between migration commit boundaries using the fault-injection harness and prove deterministic recovery.
6. Log out and prove neither the new nor old self-hosted key can restore authority.
7. Re-snapshot all Cloud files and prove no access/mutation.
8. Invoke removed Cloud commands/mode and capture their ordinary failure.
9. Build the catalog/deployment target to prove Cloudflare/Alchemy survival.

Capture origins, request paths, statuses, safe error codes, profile keys, and file metadata. Never capture credential values.

### Full gate and review

```sh
pnpm verify
```

Run the repository code-review workflow against the implementation base. Review standards/security/data safety and this plan independently. Require particular review of filesystem crash states, origin collisions, secret non-observation, generic Project Binding preservation, public export deletion, generated artifact ownership, and Cloudflare/Alchemy exclusions. Resolve every actionable finding, rerun affected focused checks, then rerun `pnpm verify` once if fixes changed behavior or generated artifacts.

## Machine-checkable acceptance criteria

- No production module imports `packages/core/src/cloud-auth/**` or the deleted Cloud product modules.
- No CLI, native, setup, doctor, telemetry, completion, config, or public type accepts `cloud` as a Caplets runtime mode.
- No live command or current doc exposes `caplets cloud`, Cloud workspaces, Cloud Vault, or hosted sandbox setup.
- Any HTTP(S) origin uses the same generic Current Host resolver regardless of hostname.
- New non-origin remote URLs are rejected safely before network/filesystem authority is used.
- Remote Profiles have one generic key space and no Cloud/self-hosted kind or workspace selection.
- Every valid legacy `self-hosted:` profile and credential migrates to one `remote:` key with identity/timestamps and credential bytes preserved.
- Migration is lock-protected, idempotent, crash-recoverable, and fail-closed on collisions/inconsistency.
- No observable state pairs old metadata with new credentials or vice versa.
- Legacy self-hosted keys cannot resurrect authority after successful logout.
- Legacy Cloud auth/profile/credential/selection files receive no file operation and remain byte/mode/mtime/name identical.
- Legacy Cloud credentials never authorize a generic remote, including a former Cloud hostname.
- Current Host Remote Login, refresh, revoke/logout, remote CLI Admin/add/catalog/Vault, downstream MCP/Attach, and native remote remain covered and green.
- Generic SDK/WebSocket Project Binding, server routes, lifecycle guards, fingerprint/sync filters, size bounds, and safe errors remain covered and green.
- Proprietary Cloud presence, workspace file upload, Cloud tier, workspace, billing, and subscription code is absent.
- Hosted runtime-plan, resource-placement, sandbox-state, and hosted setup-target public contracts are absent.
- Local and remote-host setup plus generic install risk checks remain green.
- `findProjectRoot` lives in a neutral module with its behavior preserved.
- Cloud Auth and runtime-plan root/subpath exports are absent; supported public package seams still build/import.
- Config schema, OpenAPI, and generated SDK are current and contain only surviving generic contracts.
- Cloudflare/Alchemy source, workflows, scripts, dependencies, and catalog Caplet remain intact and build.
- Current docs and the existing unreleased changeset describe the clean cutover; dated plans/ADRs/changelogs remain historical.
- Focused tests, migration/runtime smoke, package/deployment builds, code review, and `pnpm verify` pass.

## Risks, rollback, and data safety

### Atomicity and credential loss

The highest risk is committing profile metadata without its credential, overwriting a destination during an origin collision, or deleting the old pair before the new pair is proven readable. The profile-as-commit-point protocol, raw-byte copy, global lock, destination collision check, read-back verification, and fault injection are mandatory. Do not simplify this to two ordinary `save` calls followed by two deletes.

### Origin collapse

Legacy path-prefixed profiles can collapse onto one origin. Silent newest-wins behavior could attach with the wrong client identity. Collision is a hard, safe error with no mutation. The operator must remove ambiguity by choosing/re-authenticating one generic origin; the implementation must not infer intent.

### Legacy Cloud credential observation

Even a harmless-looking `existsSync`, migration probe, directory-wide JSON parse, status fallback, or logout cleanup can observe or mutate obsolete Cloud state. Prefix-filter before opening, ignore `CAPLETS_CLOUD_AUTH_PATH`, and enforce the syscall-level test. Never “clean up” Cloud files during rollback or completion.

### Generic remote regression

Cloud and Current Host paths are interleaved in CLI, selection, native, Vault, doctor, and Project Binding code. Large deletion can accidentally remove the generic adapter or weaken refresh/lifecycle behavior. Each slice freezes generic behavior first and keeps the Current Host interface as its test surface.

### Hosted taxonomy versus safety metadata

Not every `runtimeFeatures` occurrence is a hosted placement promise; some protect install confirmation. Delete hosted planning/capacity interfaces, but preserve generic risk inference. Review by meaning and caller, not by string replacement.

### Public and generated contract breakage

This is an intentional pre-release breaking cutover. Root exports, a package subpath, config fields, error enums, CLI argv, and native modes disappear together. Stale generated SDK/OpenAPI/config schema would publish a ghost interface. Generator checks and consumer compile coverage are release blockers.

### Deployment name collision

“Cloud removal” is not “remove everything containing cloud.” Cloudflare and Alchemy are deployment technologies for supported apps. Their build is an explicit preservation smoke, and their manifest/lockfile entries require callsite evidence before removal.

### Rollback

There is no runtime compatibility switch. Before rollout, back up the generic auth root with permissions preserved. A source rollback after self-hosted migration may not understand `remote:` keys because the old keys are deleted only after verified commit; restore the backed-up self-hosted pair or complete Remote Login again. Do not copy a possibly rotated new refresh token into an old format by hand.

Legacy Cloud files remain untouched, so rolling back to a build that still supports Cloud can see exactly the prior Cloud bytes. That is data preservation, not a promise that the hosted endpoint still exists or credentials remain valid.

No SQL schema rollback is expected solely for Cloud deletion. Historical hosted setup rows remain inert and must not be executed after rollback without the old hosted implementation. Roll back the source, generated artifacts, docs, and package metadata as one release unit; do not restore only Cloud CLI aliases around a generic profile store.

## Completion notes

> Completed 2026-07-20. All fields below describe the verified pre-release cutover.

- Implementation base commit: `ac12a174`
- Completion commit: `4518a04` (behavioral closure; this record is committed immediately after it)
- Final status/date: `COMPLETE`, 2026-07-20
- Implemented slices: generic origin-keyed Remote Profiles and guarded legacy self-hosted migration; Cloud mode, command, environment, workspace, hosted runtime/setup/export, API, and generated-surface deletion; generic Current Host CLI/native/Project Binding/Vault preservation.
- Deviations from fixed decisions (expected: none): none.
- Self-hosted migration and crash-recovery evidence: `packages/core/test/remote-profiles.test.ts` covers self-hosted key migration, interrupted migration recovery, collision refusal, mode preservation, and credential permission handling.
- Legacy Cloud non-observation/byte-preservation evidence: the Remote Profile regression suite rejects Cloud credentials as generic input and verifies legacy Cloud files are neither read, rewritten, nor removed.
- Generic Current Host CLI/native/Project Binding/Vault smoke evidence: focused core, CLI, Opencode, Pi, SDK, dashboard, and built-package checks passed; the built-package smoke exercised Remote Login, Admin, Attach, Project Binding, and Vault paths against a generic loopback Current Host.
- Hosted runtime/setup/export deletion evidence: active-source and generated-artifact checks contain no hosted mode, workspace, setup, export, or Cloud-only command surface; the strict-route smoke returns exact 404 responses for removed paths.
- Generated config/OpenAPI/SDK artifact evidence: `pnpm schema:check`, `pnpm openapi:check`, Code Mode generated-API checks, and SDK artifact tests passed within `pnpm verify`.
- Cloudflare/Alchemy preservation build evidence: the full Turbo build completed for the catalog, docs, landing, dashboard, SDK, core, CLI, Opencode, and Pi packages; unrelated Cloudflare/Alchemy deployment sources remain in place.
- Documentation and changeset evidence: current product, architecture, SDK, CLI, storage, deployment, and troubleshooting docs describe the generic Current Host model; `.changeset/current-host-admin-api.md` records the public cutover.
- Focused verification commands and results: focused core storage/Admin/Remote Profile suites, SDK/dashboard checks, required PostgreSQL contracts (11 files, 63 tests), `node scripts/check-package-runtime.mjs`, and `pnpm compose:smoke` passed.
- `pnpm verify` result: passed on 2026-07-20; 212 Vitest files passed, 8 skipped, with 2,996 tests passed and 46 skipped, followed by benchmark and full build/package smoke success.
- Standards/security/data-safety review result: no findings; credential locality, legacy-byte preservation, strict route deletion, SQL durability, bounded bundle memory, and rollback behavior were accepted.
- Spec review result: no findings against Plans 000, 022, and 023 after the final closure fixes.
- Rollback backup/restore notes: follow the rollback procedure above as one release unit; preserve permissions when backing up generic auth roots, restore the verified self-hosted pair or repeat Remote Login, and leave legacy Cloud files untouched.
