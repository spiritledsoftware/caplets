---
title: Vault CLI, Runtime, and Remote Paths Handle $vault Refs Consistently
date: 2026-06-22
category: integration-issues
module: Vault
problem_type: integration_issue
component: tooling
symptoms:
  - "self-hosted remote control could forge raw Vault reveal output"
  - "best-effort config validation rejected granted $vault URL fields"
  - "caplets vault set rejected real piped stdin input"
  - "grant remaps kept stale stored-key mappings"
  - "failed forced set-and-grant flows could leave mutated Vault values"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - vault
  - cli
  - remote-control
  - runtime-loader
  - config-validation
  - quarantine
  - grants
---

# Vault CLI, Runtime, and Remote Paths Handle $vault Refs Consistently

## Problem

Caplets Vault added encrypted string values that config can reference with `$vault:NAME` or `${vault:NAME}`. The feature worked at the direct CLI path, but review found that adjacent execution surfaces did not all enforce the same Vault rules.

The most serious symptom was raw reveal: self-hosted remote control accepted caller-provided `revealContext=human-cli` request data, so a generic authenticated remote-control caller could ask for a raw Vault value. Other symptoms were less severe but came from the same boundary problem: validation could reject valid `$vault:` fields, runtime paths could execute with unresolved Vault references, grant remaps could keep stale stored keys, and failed set-and-grant flows could leave partially mutated Vault state.

Relevant code paths:

- `packages/core/src/remote-control/dispatch.ts`
- `packages/core/src/config.ts`
- `packages/core/src/cli.ts`
- `packages/core/src/vault/access.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/cloud/client.ts`

## Symptoms

- `vault_get reveal=true` could be exercised through generic self-hosted remote control instead of only an explicit human reveal path.
- Best-effort config validation quarantined Caplets that were valid once resolved with the same Vault context used at runtime.
- `caplets vault set` advertised stdin support, but real non-TTY stdin was rejected unless tests injected a reader.
- Forced set-and-grant flows could overwrite an existing Vault value and then fail to create the matching grant.
- Access grants were not fully identified by `capletId + referenceName + origin`, so remapping or moving config could collide with stale identity.
- Engine startup and reload could quarantine Vault-backed Caplets without surfacing useful diagnostics to the operator or harness.

## What Didn't Work

Trusting a caller-supplied "human CLI" reveal marker did not hold up. It was request data, not proof that the request came from an interactive human surface. The self-hosted remote dispatcher needed to reject raw reveal directly rather than forwarding that decision to the request payload.

Keeping parse-level config loading pure was still the right design, but relying on pure `loadConfig` or `loadConfigWithSources` in runtime-adjacent paths caused broken behavior. Constrained fields such as URLs could be validated before Vault interpolation, and direct engine execution could receive literal `$vault:` references instead of resolved values or quarantine warnings.

The initial grant model also let stale mappings survive remaps. If grant identity includes the stored key, then granting `GH_TOKEN_PERSONAL` to a Caplet reference and later remapping that same reference to another stored key can create a second grant instead of replacing the first.

On the write path, treating `vault set --grant` as two loosely related writes left a bad failure mode. Rollback for newly created values was not enough; forced updates also need to restore the previous encrypted value if grant creation fails.

## Solution

Treat Vault as runtime-owned state and make each execution boundary apply the same policy.

Raw reveal is blocked in the self-hosted remote dispatcher. Cloud still sends an explicit `revealContext=human-cli` in the client request shape so the Cloud implementation can make the same server-side distinction, but the Cloud server implementation is outside this repository.

```ts
if (request.command === "vault_get" && reveal) {
  throw new CapletsError(
    "REQUEST_INVALID",
    "Self-hosted remote Vault reveal is not supported through remote control.",
  );
}
```

Runtime config loading now uses the Vault-aware loader. `CapletsEngine` defaults to `loadLocalRuntimeConfig`, and startup/reload warnings flow through `writeErr` so local `serve`, native, and direct CLI engine paths do not silently drop Vault-backed Caplets.

Best-effort validation now receives the same Vault resolver and source metadata as runtime interpolation. That lets fields validate after applying the actual `$vault:` resolution context, including the config origin needed for grant checks.

Grant identity is now the reference identity, not the stored secret identity:

```ts
function sameGrantIdentity(left: VaultAccessGrant, right: VaultAccessGrant): boolean {
  return (
    left.referenceName === right.referenceName &&
    left.capletId === right.capletId &&
    sameOrigin(left.origin, right.origin)
  );
}
```

That lets a remap update `storedKey` for the same Caplet reference instead of accumulating competing grants.

`vault set --grant` is transactional from the user's point of view. If grant creation fails, the value write is rolled back whether it created a new value or forced an update over an existing one.

```ts
try {
  if (grantInput) store.grantAccess(grantInput);
} catch (error) {
  if (existed && previousValue !== undefined) {
    store.set(name, previousValue, { force: true });
  } else {
    store.delete(name);
  }
  throw error;
}
```

The CLI also reads real piped stdin when `--value` is omitted, strips one trailing newline, rejects empty input, returns JSON for remote `vault set --json`, and formats Cloud access lists even when the Cloud response omits `origin`.

## Why This Works

The underlying issue was not one bad branch. It was inconsistent policy at the boundaries where Vault touched config, CLI, remote control, Cloud, and runtime startup.

The fix makes the answer to each boundary question explicit:

- Raw reveal is a privileged human operation, so generic self-hosted remote control rejects it.
- Runtime execution uses Vault-aware loading, so execution surfaces either receive resolved config or recoverable quarantine diagnostics.
- Validation uses the same resolver and source metadata as runtime interpolation, so validation and execution no longer disagree about valid `$vault:` references.
- Grant identity follows the Caplet reference and config origin, so remapping a reference replaces the grant target instead of leaving stale stored-key authority.
- Set-and-grant behaves atomically, so setup commands do not leave misleading partial state after a grant failure.

This also matches the older Remote Profile lesson: auth-bearing or secret-bearing values should be resolved as runtime-owned state, not copied into long-lived process startup state or agent config.

## Prevention

- Treat raw secret reveal as a separate capability. Generic transport and remote-control layers should reject it unless they can prove the caller is the intended human surface.
- Use the Vault-aware runtime loader for execution surfaces. Keep parse-level helpers pure, but do not use pure config loaders as runtime entry points.
- Pass source metadata through interpolation and validation whenever access decisions depend on config origin.
- Key Vault grants by Caplet reference identity and origin, then store the mapped Vault key as mutable grant data.
- Make combined write-and-grant flows rollback-safe for both create and forced-update cases.
- Emit recoverable quarantine warnings at startup and reload, not only in `caplets doctor`.

Regression tests should cover:

- forged self-hosted remote `vault_get reveal=true`
- `$vault:` interpolation in constrained config fields such as URLs
- real piped stdin for `caplets vault set`
- grant remap replacement
- rollback for failed set-and-grant creates and forced updates
- runtime startup warnings for Vault quarantine
- Cloud client reveal request shape and access-list formatting

## Related Issues

- Related high-overlap doc: [Native Remote Clients Refresh Runtime Credentials Before Polls and Reconnects](./stale-remote-profile-credentials-refresh.md). It covers the same runtime-owned-state rule for Remote Profile credentials.
- Related moderate-overlap doc: [Code Mode REPL Sessions Use Live State Plus Recovery Journals](../architecture-patterns/code-mode-repl-sessions.md). It covers agent-facing runtime state and redaction boundaries.
- Related moderate-overlap doc: [Native Daemon Management Belongs Behind an Install-Time Service Contract](../architecture-patterns/native-daemon-service-management.md). It covers service lifecycle ownership, but not Vault quarantine diagnostics.
- GitHub issue search found no matching open or closed issues for this Vault review cluster.
