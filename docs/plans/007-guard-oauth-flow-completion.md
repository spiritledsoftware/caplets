# Plan 007: Persist And Guard Backend OAuth Flow Completion

> Status: COMPLETE
> Planned against: `ac12a174`
> Finding: #7 — OAuth flow state is node-local and deleted before fallible completion
> Priority: P0
> Effort: L
> Fix risk: HIGH
> Depends on: Plan 003
> Required by: Plan 000

## Why this matters

Backend OAuth start currently stores a `complete(callbackUrl)` closure in an in-memory `RemoteAuthFlowStore`. Completion deletes the flow before awaiting token exchange. A transient failure makes the flow unrecoverable, concurrent callbacks can execute the one-shot exchange twice, process restart loses every flow, and a callback routed to another Host Node cannot complete.

The Admin API in Plan 000 is host-scoped, not node-scoped. Pending backend OAuth state must therefore be encrypted Authoritative Host State with explicit claim, release, guarded finalization, and terminal cleanup.

## Scope

### In scope

- `packages/core/src/auth.ts` provider state extraction/reconstruction
- `packages/core/src/remote-control/auth-flow.ts` replacement with a semantic coordinator
- New SQLite/PostgreSQL backend-auth-flow schema, migrations, and repository
- `packages/core/src/storage/database.ts` wiring
- Existing v1 start/callback dispatch as the first Adapter
- SQLite/PostgreSQL, dispatch, and real HTTP callback tests
- One patch changeset for `@caplets/core`

### Out of scope

- V2 route names or Problem Details; Plan 000 owns HTTP presentation
- Encrypting existing persisted backend token bundles
- Provider capability redesign, token refresh policy, or OAuth app registration policy
- Durable asynchronous job execution
- Dashboard UI changes

## Required design

### Serializable encrypted state

Replace stored closures with a versioned `BackendAuthFlowState` sufficient to reconstruct completion for MCP and generic OAuth targets. It includes only what completion requires: flow/server identity, provider family, redirect URI, state verifier, PKCE verifier, resolved client identity needed for exchange, relevant endpoint/config fingerprint, starting backend-auth generation, creation/expiry, and safe status metadata.

Encrypt the completion payload with existing AES-256-GCM primitives and the host encryption-key provider. Bind ciphertext to flow ID, server ID, and envelope version as authenticated context. Multi-node PostgreSQL deployments must use a shared `CAPLETS_ENCRYPTION_KEY`; a node that cannot load the configured key fails backend-auth flow operations closed.

Never return or log encrypted payloads, provider state, PKCE verifiers, authorization codes, client secrets, or tokens. List/detail projections expose only safe flow ID, server, state, and timestamps.

### Authoritative lifecycle

Use these states:

```text
pending -> completing -> completed
   ^           |
   +-----------+ transient failure

pending/completing -> expired
```

Rules:

1. Start persists the encrypted flow before returning the authorization URL.
2. Completion validates provider error/state/expiry before token exchange.
3. Claim is an atomic compare-and-set from `pending` to `completing` with a unique claim token and timestamp.
4. A concurrent callback cannot acquire the claim and receives a stable in-progress conflict.
5. A retryable exchange/storage failure releases only the matching claim back to `pending`; another claim cannot be released.
6. Success persists the backend credential result and terminalizes/scrubs the flow through guarded finalization. If these cannot share one transaction, store a correlation marker that lets a retry prove the token write belongs to this flow and finish terminalization without exchanging the code twice.
7. A callback disconnect never cancels an acquired completion. The coordinator finishes token persistence and finalization.
8. An abandoned `completing` claim never blindly re-exchanges a code. Reconcile from the correlated backend-auth write; if outcome cannot be proved, fail closed with an explicit unknown state.
9. Completed/expired rows retain only safe metadata for a bounded period, then prune. Encrypted completion material is cleared at terminal transition.
10. SQLite uses its transaction boundary; PostgreSQL uses row-level locking/CAS. No process-local mutex is correctness-bearing.

### Provider reconstruction

Extend `FileOAuthProvider` and generic OAuth completion so state/PKCE values can be supplied from validated stored state instead of always generated in private fields. Keep local loopback OAuth behavior intact by adapting it through the same pure start/complete primitives.

Separate external token exchange from authoritative persistence enough to support guarded finalization. Do not serialize functions, SDK instances, fetch implementations, or raw config objects. Re-resolve the configured target at completion and reject a changed security-sensitive fingerprint rather than completing against different endpoints/client identity.

## Implementation steps

1. Add failing repository tests for encrypted round-trip, wrong key/AAD, expiry, atomic claim, concurrent claim, matching release, terminal scrub, prune, and PostgreSQL row races.
2. Refactor OAuth start/complete into serializable state plus reconstruction without changing local CLI behavior.
3. Add the authoritative coordinator and backend-auth correlation/finalization path.
4. Adapt existing `/v1/admin` auth start and callback to the coordinator; remove `RemoteAuthFlowStore` closure storage.
5. Add real HTTP tests in which start and callback use different app/Host Node instances sharing PostgreSQL and the encryption key.
6. Add transient exchange/storage, disconnect, process-abandonment, replay, provider-error, state-mismatch, config-drift, and expiry tests.
7. Update Plan 000 route integration notes and add a patch changeset.

## Verification

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/serve-http.test.ts
CAPLETS_REQUIRE_TEST_POSTGRES=1 CAPLETS_TEST_POSTGRES_URL="$CAPLETS_TEST_POSTGRES_URL" \
  pnpm --filter @caplets/core test -- test/host-storage-domain-parity.postgres.test.ts
pnpm --filter @caplets/core typecheck
pnpm format:check
pnpm lint
```

The PostgreSQL command must include the new focused backend-auth-flow suite if it is separate.

Smoke a built two-node server setup against one PostgreSQL database and shared encryption key: start on node A, complete through node B, then verify safe status and usable backend credentials from both nodes.

## Completion criteria

- No correctness-bearing backend OAuth flow closure remains in process memory.
- Pending flow payloads are authenticated-encrypted and unreadable without the shared host key.
- Start survives restart and callback routing to another Host Node.
- Concurrent completion is single-flight.
- Retryable failure releases safely; success terminalizes once; ambiguous abandoned work fails closed.
- Terminal rows contain no completion secret material.
- Existing local OAuth and frozen v1 response behavior remain compatible.
- SQLite/PostgreSQL concurrency tests, HTTP tests, smoke, typecheck, format, and lint pass.

## Escape hatches

- If the MCP SDK cannot resume from caller-supplied state/PKCE without persisting an opaque executable object, stop and isolate a provider-specific adapter or replace that SDK start/complete seam. Do not fall back to node affinity.
- If backend token persistence cannot be correlated with flow finalization, retain an explicit unknown terminal state. Never re-exchange automatically after an ambiguous commit.
- If a shared encryption key is unavailable in multi-node mode, reject backend OAuth start with a safe availability error.

## Maintenance note

One-shot external callbacks require durable `claim -> complete/release -> guarded finalization`. A node-local closure or `delete -> await` sequence is never sufficient for Current Host administration.
