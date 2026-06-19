---
title: Native Remote Clients Refresh Runtime Credentials Before Polls and Reconnects
date: 2026-06-19
category: integration-issues
module: Native remote
problem_type: integration_issue
component: authentication
symptoms:
  - background pollers kept using stale remote profile credentials after refresh
  - attach event reconnects reused the old authorization header
  - remote reloads and stale retries continued against outdated runtime options
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - native-remote
  - remote-profile
  - credential-refresh
  - runtime-options
  - background-polling
  - attach-events
  - reconnects
---

# Native Remote Clients Refresh Runtime Credentials Before Polls and Reconnects

## Problem

Native remote clients were constructed with a one-time snapshot of remote runtime options. That included auth-bearing `requestInit`, so background manifest polling and attach event stream reconnects could keep using stale Remote Profile credentials after the profile refreshed.

The immediate fix was commit `c354eaf` (`fix(core): refresh native remote background auth`).

## Symptoms

- Background attach event reconnects could keep sending the original `Authorization` header.
- Fallback polling for the remote attach manifest reused stale auth.
- Explicit user actions could refresh through `ProfileBackedNativeCapletsService`, while long-lived SDK clients continued with captured options.
- Stale-manifest retry logic inside tool execution did not help independent background fetch and reconnect paths.

## What Didn't Work

- Refreshing credentials before explicit `reload()` and `execute()` calls was not enough; the poll timer and SSE reconnect loop can run without a user action.
- Resetting a remote client on session failures did not cover auth-stale background requests, because the failing background requests were using a stale but structurally valid client.
- Retrying only after `ATTACH_MANIFEST_STALE` addressed changed exports, not changed credentials.
- Env-based remote setup was the wrong product direction for this class of issue. Prior session history settled on `caplets remote login <url>` plus Caplets-owned Remote Profiles, because agent env inheritance can be unreliable and can persist secrets in agent config (session history).
- One-time Remote Profile resolution at process startup fixed the first request but not long-running native services and attach streams after access credentials expired or rotated (session history).

## Solution

Make the SDK remote client resolve runtime options at request time rather than at construction time.

The SDK client now accepts a resolver:

```ts
export type SdkRemoteCapletsClientOptions = RemoteCapletsClientOptions["remote"] & {
  resolveRuntimeOptions?: () => Promise<RemoteCapletsClientOptions["remote"]>;
};
```

Then all outbound remote operations go through current runtime options:

```ts
const fetchCurrentManifest = async (): Promise<AttachManifest> => {
  const runtimeOptions = await resolveRuntimeOptions();
  return await fetchAttachManifest(
    runtimeOptions.url,
    runtimeOptions.requestInit,
    runtimeOptions.fetch ?? fetch,
  );
};

const invokeCurrentExport = async (body: {
  revision: string;
  kind: string;
  exportId: string;
  input: unknown;
}): Promise<unknown> => {
  const runtimeOptions = await resolveRuntimeOptions();
  return await invokeAttachExport(
    runtimeOptions.url,
    runtimeOptions.requestInit,
    runtimeOptions.fetch ?? fetch,
    body,
  );
};
```

Apply the same rule to attach event stream startup and reconnect:

```ts
const startEventsNow = async () => {
  try {
    const runtimeOptions = await resolveRuntimeOptions();
    if (closed || eventsAbort || listeners.size === 0) return;
    eventsAbort = startAttachEvents(
      runtimeOptions.url,
      runtimeOptions.requestInit,
      runtimeOptions.fetch ?? fetch,
      listeners,
      onClose,
    );
  } catch {
    scheduleEventsReconnect();
  }
};
```

The profile-backed service wires its existing profile resolver into the client factory:

```ts
const sdkOptions: SdkRemoteCapletsClientOptions = {
  ...remoteOptions,
  resolveRuntimeOptions: resolveRuntimeRemoteOptions,
};
```

That keeps `RemoteNativeCapletsService` responsible for polling and subscription lifecycle while `ProfileBackedNativeCapletsService` remains responsible for turning Remote Profiles into current request credentials.

## Why This Works

The root cause was request-time staleness. The client had copied credentials into a long-lived closure, so later refreshes could update the profile without changing the headers used by pollers and reconnects.

Resolving runtime options immediately before each remote request makes credential freshness independent of client lifetime:

- manifest polling re-reads auth before each fetch
- attach event stream reconnects re-read auth before opening the next stream
- tool invokes and stale-manifest retries use the same request-time auth path
- profile-backed Remote Login remains the source of truth instead of agent env or startup-only state

The event path also tracks closed state and event-start in-flight state so reconnect attempts do not duplicate or continue after shutdown.

## Prevention

- Treat auth-bearing request options as runtime state whenever credentials can refresh independently of client lifetime.
- Audit background HTTP paths separately from explicit user calls. Pollers, reconnect loops, heartbeat jobs, and retry helpers often bypass the refresh points used by direct commands.
- Regression-test token rotation at the transport boundary. The tests added with this fix assert that a second attach event connection and a later fallback poll observe `Bearer token-2` after the token changes.
- Keep Remote Profile resolution in the profile-backed layer and pass a resolver into lower-level clients instead of teaching lower layers how to read credential stores.

## Related Issues

- Related low-overlap doc: [Code Mode REPL sessions](../architecture-patterns/code-mode-repl-sessions.md). It covers stale live state and recovery behavior, but not Remote Profile auth, attach event streams, or background polling.
- GitHub issue search found no matching issues for remote auth, attach profile, stale credentials, or polling event stream credentials.
