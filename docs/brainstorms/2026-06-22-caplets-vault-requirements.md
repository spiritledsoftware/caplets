---
date: 2026-06-22
topic: caplets-vault
---

# Caplets Vault Requirements

## Summary

Caplets Vault is a runtime-owned encrypted string store that config can reference with `$vault:NAME` or `${vault:NAME}`. Vault values replace fragile agent-harness environment propagation for secret-like config values while preserving the same interpolation exclusions and Caplet quarantine behavior as environment references.

---

## Problem Frame

Caplets currently relies on environment variables for many secret-like config values. That is a high-failure surface for agent harnesses because the harness that starts the agent may not pass the same environment through to the Caplets MCP process.

Existing remote-auth work already moved remote credentials into Caplets-owned credential storage because agent env inheritance can be unreliable and can persist secrets in agent config. Caplets Vault applies the same product direction to ordinary backend config values: users set the value once in the runtime that needs it, and config references the stable key name.

The known v1 catalog migration inventory is `caplets/github/CAPLET.md`, which uses `$env:GH_TOKEN` for a bearer token, plus the matching GitHub catalog setup docs that tell users to export `GH_TOKEN`. V1 migration succeeds when this inventory uses Vault references and setup language, and repository checks prevent new secret-like catalog `$env:` or bare `${NAME}` references after Vault ships.

---

## Key Decisions

- **Vault, not Secrets.** The feature is named Caplets Vault because it stores encrypted string values for config interpolation, not only API credentials.
- **One v1 value type.** Vault values are strings only in v1 because interpolation resolves into existing string config fields.
- **Runtime-owned stores.** Each runtime resolves `$vault:NAME` from its own Vault store. Local Caplets do not read, mirror, or forward remote or Cloud Vault values.
- **Local/global default.** `caplets vault` targets the local global Vault by default. `--global` is accepted as an explicit alias for the default, and `--remote` targets the authenticated selected remote runtime.
- **No project Vault scope.** Vault v1 has no project-scoped store and no committed encrypted `.caplets` Vault files.
- **Runtime-owned encryption key source.** Vault encryption uses runtime-owned key material. Local v1 installs mint and store a Vault encryption key in Caplets user data with owner-only permissions, while headless and self-hosted runtimes may provide key material through `CAPLETS_ENCRYPTION_KEY`.
- **Grant-level key mapping.** Vault keys remain runtime-global, but an access grant can satisfy a Caplet's referenced key name with a differently named stored Vault key. Users who need personal and work variants use distinct Caplet instance IDs such as `github-personal` and `github-work`.

---

## Actors

- A1. **Caplets user.** Sets, updates, lists, deletes, and occasionally reveals Vault values through the CLI.
- A2. **Caplets runtime.** Loads config, resolves `$vault:NAME`, and quarantines affected Caplets when Vault values cannot be resolved.
- A3. **Agent-facing client.** Uses exposed Caplets but cannot directly read raw Vault values.
- A4. **Remote runtime.** Owns and resolves its own Vault store when the user targets it with `--remote`.

---

## Requirements

**Vault Naming And Values**

- R1. Caplets exposes the feature as Caplets Vault in user-facing CLI, docs, diagnostics, and requirements.
- R2. Config references Vault values with `$vault:NAME` or `${vault:NAME}`.
- R3. Vault values are strings in v1.
- R4. Vault references do not include provider qualification in v1.
- R5. Vault key names use an env-like grammar of uppercase ASCII letters, digits, and underscores, start with a letter or underscore, are at most 128 characters, and reject whitespace, control characters, path separators, interpolation delimiters, colons, and other provider-qualified syntax.

**Interpolation And Config Loading**

- R6. `$vault:NAME` and `${vault:NAME}` resolve everywhere `$env:NAME` and `${NAME}` currently resolve.
- R7. Vault interpolation follows the same public-metadata exclusions as environment interpolation, so public descriptions and tags preserve the reference text instead of expanding values.
- R8. Missing, locked, or unavailable Vault values quarantine only the affected Caplet.
- R9. Vault quarantine warnings show the Vault key name and config path needed for recovery.
- R10. Vault warnings, diagnostics, logs, and JSON output never print raw Vault values unless the user explicitly asks a human-facing CLI command to reveal one.

**CLI Management**

- R11. `caplets vault set NAME` stores a string in the local global Vault by default.
- R12. `caplets vault set NAME --global` is accepted as an explicit alias for the default local global target.
- R13. `caplets vault set NAME --remote` stores a string in the authenticated selected remote runtime's Vault.
- R14. `caplets vault set NAME` prompts without echo in an interactive shell when no non-argv value source is provided.
- R15. Non-interactive `caplets vault set NAME` fails clearly when no non-argv value source, such as stdin, is provided.
- R16. Raw Vault values are not accepted as command-line argument values.
- R17. Updating an existing Vault key requires `--force`.
- R18. `caplets vault list` shows key names plus safe metadata such as target, provider, status, and timestamps.
- R19. Human-facing CLI reveal requires an explicit show action, such as `caplets vault get NAME --show`.
- R20. Human-facing CLI commands may show raw values only through explicit reveal output; agent-facing MCP and Code Mode surfaces do not expose any operation that returns or reveals raw Vault values.
- R21. `caplets vault delete NAME` removes or invalidates the active stored value for the selected target without revealing the value.
- R22. After deletion, future references to that Vault key quarantine as missing unless a new value is set.
- R23. Vault status output makes any retained backup, recovery, or remote retention state explicit without revealing values.

**Runtime And Remote Boundaries**

- R24. Local Caplets resolve `$vault:NAME` from the local global Vault store.
- R25. Self-hosted remote Caplets resolve `$vault:NAME` from the self-hosted runtime's Vault store.
- R26. Cloud Caplets resolve `$vault:NAME` from the Cloud workspace Vault store.
- R27. `--remote` Vault management uses the same authenticated remote selection model as other remote CLI operations.
- R28. Local runtimes do not fetch, forward, or mirror remote or Cloud Vault values.
- R29. Vault setup docs name the active Vault target and the matching setup command for local, self-hosted remote, and Cloud-backed runtimes.
- R30. Unresolved-reference diagnostics name the Vault target that was checked and the command needed to set or grant the key for that target.
- R31. Remote Vault set and update operations use authenticated encrypted transport, and the CLI, proxy, and remote runtime do not log raw Vault values.

**Security And Unlocking**

- R32. Vault stores encrypted secret material on disk.
- R33. Local v1 installs mint a Vault encryption key when needed and store it in the Caplets user data directory with owner-only filesystem permissions.
- R34. `CAPLETS_ENCRYPTION_KEY` can provide Vault key material for headless, self-hosted, or runtime-managed deployments that do not want to persist a local key file.
- R35. Agent-facing startup does not prompt for Vault unlock input or receive Vault encryption key material.
- R36. Missing, unreadable, wrong-permissioned, or invalid Vault encryption key material is treated like an unresolved reference during config loading.
- R37. Vault status output reports enough information to diagnose key-source, unavailable, missing, and healthy states without revealing values.
- R38. V1 keeps the encryption key source boundary narrow enough that OS keychain-backed key storage can be added later without changing `$vault:NAME`, Vault CLI commands, or stored value semantics.

**Future Provider Shape**

- R39. V1 ships with the built-in Caplets encrypted Vault provider only.
- R40. V1 does not add external-provider abstractions or plumbing unless they are required for the built-in Caplets encrypted Vault provider.

**Catalog Migration**

- R41. Catalog Caplets under `caplets/` use Vault references instead of environment references for user-supplied secret-like values.
- R42. Catalog documentation tells users to set required secret-like values through `caplets vault set` instead of exporting environment variables.
- R43. Catalog migration preserves non-secret auth flows such as OAuth commands that already store credentials in Caplets-owned auth state.
- R44. The built-in catalog does not introduce new `$env:` or bare `${NAME}` references for secret-like values after Vault ships.

**Vault Access Grants**

- R45. Vault value resolution requires an access grant for the Vault key, Caplet ID, and config origin; knowing the key name is not enough to resolve the value.
- R46. Unauthorized Vault references quarantine the affected Caplet like unresolved Vault references, while diagnostics distinguish ungranted access from missing, locked, or unavailable values.
- R47. `caplets vault access grant NAME <capletId>` grants a Caplet access to resolve one Vault key from its current config origin.
- R48. `caplets vault access revoke NAME <capletId>` removes a Caplet's access to one Vault key.
- R49. `caplets vault access list NAME` lists the Caplets that can resolve one Vault key without revealing the value.
- R50. `caplets vault access list --caplet <capletId>` lists the Vault keys that one Caplet can resolve without revealing values.
- R51. `caplets vault set NAME --grant <capletId>` stores a value and grants access in one interactive human setup flow.
- R52. `caplets vault access grant NAME <capletId> --as <referenceName>` grants one stored Vault key as the value for the named `$vault:<referenceName>` reference in that Caplet's config.
- R53. `--as` defaults to the stored Vault key name, so `caplets vault access grant GH_TOKEN github` is equivalent to granting `GH_TOKEN` as `GH_TOKEN`.
- R54. Users who need different values for the same catalog reference name configure distinct Caplet instance IDs and grant each instance a different stored Vault key with `--as`.
- R55. `caplets doctor` reports Caplets that reference Vault keys without matching access grants and prints the exact repair command.
- R56. `caplets attach` and runtime startup surface ungranted Vault references as preflight diagnostics before agent harnesses silently lose affected Caplets.

---

## Key Flows

- F1. Local Vault setup
  - **Trigger:** A user wants a local Caplet config to stop depending on harness-passed environment variables.
  - **Actors:** A1, A2
  - **Steps:** The user runs `caplets vault set NAME`, enters the value through a non-echoing prompt, and references `$vault:NAME` or `${vault:NAME}` in config.
  - **Outcome:** The local runtime resolves the value from the local global Vault when it loads the Caplet.
  - **Covered by:** R2, R11, R14, R24

- F2. Remote Vault setup
  - **Trigger:** A user wants a self-hosted or Cloud-backed Caplet to use a Vault value in the runtime where it executes.
  - **Actors:** A1, A4
  - **Steps:** The user authenticates the remote profile, selects the remote through existing remote mode, and runs `caplets vault set NAME --remote`.
  - **Outcome:** The remote runtime stores and resolves its own Vault value without the local runtime learning the value.
  - **Covered by:** R13, R25, R26, R27, R28, R31

- F3. Unresolved Vault reference
  - **Trigger:** Config references `$vault:NAME` or `${vault:NAME}`, but the runtime cannot resolve that key.
  - **Actors:** A2, A3
  - **Steps:** The runtime loads config, detects the unresolved Vault reference, and quarantines only the affected Caplet.
  - **Outcome:** Other valid Caplets remain available, and diagnostics identify the key name and config path without revealing any value.
  - **Covered by:** R8, R9, R10, R30, R36, R37

- F4. Human reveal
  - **Trigger:** A user needs to inspect a stored value.
  - **Actors:** A1
  - **Steps:** The user runs a CLI get command and supplies the explicit show action.
  - **Outcome:** The CLI prints the value only because the local human-facing command requested reveal.
  - **Covered by:** R19, R20

- F5. Catalog Caplet setup
  - **Trigger:** A user installs or reads a catalog Caplet that needs a user-supplied token.
  - **Actors:** A1, A2
  - **Steps:** The catalog Caplet references `$vault:NAME` or `${vault:NAME}`, and its setup docs instruct the user to store the value with `caplets vault set NAME`.
  - **Outcome:** The Caplet works in agent harnesses that do not propagate shell environment variables to the Caplets MCP process.
  - **Covered by:** R41, R42, R44

- F6. Vault access grant setup
  - **Trigger:** A Caplet config references a Vault key that exists but has not been granted to that Caplet.
  - **Actors:** A1, A2
  - **Steps:** The user runs `caplets vault access grant NAME <capletId>` or uses `caplets vault set NAME --grant <capletId>` during setup.
  - **Outcome:** The runtime can resolve the Vault key only for the granted Caplet and config origin.
  - **Covered by:** R45, R47, R51, R53

- F7. Ungranted Vault reference diagnosis
  - **Trigger:** A runtime sees `$vault:NAME` or `${vault:NAME}` in a Caplet without a matching access grant.
  - **Actors:** A1, A2, A3
  - **Steps:** `caplets doctor`, `caplets attach`, or runtime startup reports the ungranted reference and shows the repair command.
  - **Outcome:** The affected Caplet fails closed without hiding the reason from the human setup path.
  - **Covered by:** R46, R55, R56

- F8. Grant-level key mapping
  - **Trigger:** A user wants two configured Caplet instances to satisfy the same catalog reference name with different stored Vault keys.
  - **Actors:** A1, A2
  - **Steps:** The user configures distinct Caplet instance IDs such as `github-personal` and `github-work`, then grants `GH_TOKEN_PERSONAL` to `github-personal --as GH_TOKEN` and `GH_TOKEN_WORK` to `github-work --as GH_TOKEN`.
  - **Outcome:** Each Caplet instance resolves `$vault:GH_TOKEN` to its granted stored key without project-scoped Vault state.
  - **Covered by:** R52, R54

---

## Acceptance Examples

- AE1. **Covers R2, R5.** Given a user sets or references a Vault key, when the key uses lowercase letters, whitespace, path separators, interpolation delimiters, colons, control characters, provider-qualified syntax, starts with a digit, or exceeds 128 characters, then Caplets rejects the key before storing or resolving it.
- AE2. **Covers R6, R7.** Given a config field that currently interpolates `$env:NAME` or `${NAME}`, when it is changed to `$vault:NAME` or `${vault:NAME}`, then the Vault value resolves in the same class of config fields and remains unexpanded in public metadata fields.
- AE3. **Covers R8, R9, R10.** Given two configured Caplets and only one references a missing Vault key, when config loads, then only the affected Caplet is quarantined and the warning names `NAME` without printing its value.
- AE4. **Covers R11, R12, R14, R15, R16, R17.** Given a user stores a local Vault value, when they use an interactive shell then Caplets prompts without echo, when they use a non-interactive shell then Caplets requires a non-argv source such as stdin, and when the key already exists then Caplets refuses to overwrite it without `--force`.
- AE5. **Covers R13, R25, R26, R27, R28.** Given an authenticated selected remote, when the user runs `caplets vault set NAME --remote`, then the remote runtime stores the value and the local runtime does not persist a copy.
- AE6. **Covers R19, R20.** Given an agent-facing Code Mode session can access Caplet handles, when it searches for ways to read or reveal Vault values directly, then no raw Vault value operation is exposed.
- AE7. **Covers R21, R22, R23.** Given a Vault key is deleted, when config later references that key, then the affected Caplet quarantines as missing and status output explains any retained recovery state without revealing values.
- AE8. **Covers R29, R30.** Given a user reads setup docs or diagnostics for a missing Vault value, when the value belongs to a remote or Cloud runtime, then the output names that target and shows the matching remote setup command rather than a local-only command.
- AE9. **Covers R31.** Given a user stores a remote Vault value, when the CLI sends it to the remote runtime, then the operation uses authenticated encrypted transport and raw values are absent from CLI, proxy, and remote logs.
- AE10. **Covers R32, R33, R34, R35, R36, R37, R38.** Given a runtime needs Vault key material, when it is a local install then Caplets can use a minted owner-only key file, when it is a headless or self-hosted deployment then `CAPLETS_ENCRYPTION_KEY` can provide key material, and when key material is unavailable or invalid then agent-facing startup does not prompt and affected Caplets quarantine with diagnostic status.
- AE11. **Covers R41, R42, R44.** Given a catalog Caplet currently needs a user-supplied token, when Vault ships, then the Caplet references Vault and its setup docs no longer instruct the user to export an environment variable for that token.
- AE12. **Covers R43.** Given a catalog Caplet already uses Caplets-owned OAuth auth state, when the catalog migration runs, then that Caplet keeps the OAuth setup flow instead of replacing it with Vault.
- AE13. **Covers R45, R46.** Given a Caplet references an existing Vault key without a matching access grant, when config loads, then that Caplet is quarantined as ungranted rather than resolving the value.
- AE14. **Covers R47, R48, R49, R50, R52, R53, R54.** Given a user manages Vault access, when they grant, revoke, list access, or map a stored key to a referenced key with `--as`, then Caplets changes or reports only access metadata and never prints raw Vault values.
- AE15. **Covers R55, R56.** Given an agent harness starts Caplets with an ungranted Vault reference, when preflight or doctor runs, then the output names the Caplet, key, target, and repair command before the missing Caplet looks like a generic startup failure.
- AE16. **Covers R52, R54.** Given `github-personal` and `github-work` both reference `$vault:GH_TOKEN`, when the user grants `GH_TOKEN_PERSONAL` to `github-personal --as GH_TOKEN` and `GH_TOKEN_WORK` to `github-work --as GH_TOKEN`, then each Caplet instance resolves its own stored key without adding project-scoped Vault state.

---

## Scope Boundaries

- Project-scoped Vault stores are out of scope for v1.
- Committed encrypted Vault files under `.caplets` are out of scope.
- Remapping one Caplet instance into multiple logical identities at grant time is out of scope; users configure distinct Caplet instance IDs for distinct account contexts.
- `$secrets:NAME` and `${secrets:NAME}` are not part of the feature; naming is Vault throughout.
- Structured values and JSON blobs are out of scope for v1.
- Provider-qualified syntax such as `$vault:aws/NAME` is out of scope for v1.
- External Vault providers are future work, not part of the built-in v1 provider.
- Future integrations with external providers such as AWS Secrets Manager or HashiCorp Vault are out of scope for v1.
- OS keychain-backed Vault key storage is future work, not part of the required v1 unlock path.
- Agent-facing APIs that reveal raw Vault values are out of scope.
- Replacing existing Caplets-owned OAuth flows with Vault is out of scope.

---

## Dependencies / Assumptions

- The implementation can reuse the existing missing-reference quarantine model used for `$env:` references.
- Remote Vault management depends on the existing authenticated remote selection model.
- Cloud Vault behavior is treated as a remote-runtime concern, not as a local secret-forwarding feature.
- Catalog migration includes the known v1 inventory in `caplets/github/CAPLET.md` and its matching GitHub catalog setup docs.
- Vault access grants are intended to be configured before runtime startup; agent-facing startup must not prompt for grants or receive raw values.
- Planning must choose the concrete local key-file storage path, permission checks, and `CAPLETS_ENCRYPTION_KEY` validation rules.

---

## Sources / Research

- `packages/core/src/config.ts` currently scans and interpolates `${NAME}` and `$env:NAME` references, and formats missing environment warnings.
- `packages/core/test/config.test.ts` verifies missing environment references quarantine only affected Caplets and preserve public metadata references.
- `packages/core/src/cli.ts` shows existing `--global` and `--remote` targeting patterns for config/auth operations.
- `packages/core/src/remote/credential-store.ts` and `packages/core/src/cloud-auth/store.ts` show adjacent Caplets-owned credential storage patterns.
- `caplets/github/CAPLET.md` currently uses `$env:GH_TOKEN` and export-based setup language for its bearer token.
- `docs/solutions/integration-issues/stale-remote-profile-credentials-refresh.md` records why env-based remote setup was the wrong product direction for remote credentials.

---

## Deferred / Open Questions

### From 2026-06-22 review

None.
