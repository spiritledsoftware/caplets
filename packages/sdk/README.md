# `@caplets/sdk`

Typed ESM client for the public Caplets HTTP API and Project Binding v1 protocol. It uses standard
Fetch and WebSocket APIs and supports Node.js 22+ and modern browsers.

## Install

```sh
npm install @caplets/sdk
```

## Create an isolated client

Every client needs the absolute HTTP(S) **Current Host Origin**: scheme, host, and optional port
only. `createClient` rejects credentials, non-root paths, queries, and fragments before network I/O;
a trailing root slash is normalized away. The fixed protocol namespaces cannot be relocated by
`baseUrl` or a reverse-proxy prefix.

```ts
import { createClient, getServiceDiscovery } from "@caplets/sdk";

const client = createClient({
  baseUrl: "https://host.example",
});

const result = await getServiceDiscovery({ client });
if (result.error) {
  // Handle the typed error. result.response may be undefined for a network failure.
} else {
  const service = result.data;
}
```

`createClient` always creates an isolated instance. There is no shared global client. It defaults to
`globalThis.fetch`, `responseStyle: "fields"`, and `throwOnError: false`.

### Authentication

Authentication is optional and caller-owned. Pass a bare token value or an async provider; the SDK
adds the bearer header only for operations whose public contract requires it.

```ts
import { createClient } from "@caplets/sdk";

const unauthenticated = createClient({
  baseUrl: "https://host.example",
});

const staticAuth = createClient({
  baseUrl: "https://host.example",
  auth: accessToken,
});

const asyncAuth = createClient({
  baseUrl: "https://host.example",
  auth: async () => getCurrentAccessToken(),
});
```

The caller owns token storage, refresh, and login policy. Do not put bearer credentials in a URL.
The OpenAPI contract also declares the host-only dashboard session cookie as an alternative for
canonical `/api/v2/admin/*` operations. The SDK does not start, restore, or store dashboard
sessions. A same-origin browser client with an already established session may use
`credentials: "same-origin"`
and supply `X-Caplets-CSRF` on unsafe Admin calls; configuring `auth` instead selects bearer mode
exclusively.

## Generated operations and types

Import generated operation families and their public types from the package root, never from
`generated` files:

```ts
import { adminV2GetHost, getHealth, type AdminV2GetHostResponse, type Problem } from "@caplets/sdk";

const health = await getHealth({ client });
const hostResult = await adminV2GetHost({ client });

if (hostResult.error) {
  const problem: Problem = hostResult.error;
} else {
  const host: AdminV2GetHostResponse = hostResult.data;
}
```

The default fields result is `{ data, error, request?, response? }` and does not throw for HTTP or
network failures. Opt into throwing per operation (or in client configuration):

```ts
const { data: host, response } = await adminV2GetHost({
  client,
  throwOnError: true,
});
```

With fields mode and `throwOnError: true`, successful calls still return `data`, `request`, and
`response`; failures reject.

## Caplet Bundle streams

Curated root helpers preserve the manifest-first multipart contract that generated JSON operations
cannot express. Downloads expose the response body without buffering:

```ts
import { adminV2GetCapletRecordBundleStream } from "@caplets/sdk";

const bundle = await adminV2GetCapletRecordBundleStream({
  client,
  path: { id: recordId },
  signal,
});

if (bundle.error) {
  // Handle the typed Problem.
} else if (bundle.data) {
  const reader = bundle.data.getReader();
  // Read chunks with reader.read(); reader.cancel() cancels consumption.
}
```

For in-memory browser uploads, preserve the caller's file order and let Fetch set the multipart
boundary:

```ts
import { adminV2PutCapletRecordBundleFormData, createOrderedBundleFormData } from "@caplets/sdk";

const body = createOrderedBundleFormData(manifestJson, files);
const uploaded = await adminV2PutCapletRecordBundleFormData({
  client,
  path: { id: recordId },
  headers: { "Idempotency-Key": idempotencyKey },
  body,
});
```

For unbuffered uploads, provide repeatable async chunk sources and a unique multipart boundary. Each
`open` callback receives the multipart body's `AbortSignal`; chunk sources must stop pending reads
and release their resources when it is aborted. Existing zero-argument `open` callbacks remain
compatible.

```ts
import { adminV2PutCapletRecordBundleStream, createOrderedBundleMultipartBody } from "@caplets/sdk";

const multipart = createOrderedBundleMultipartBody(
  manifestJson,
  [{ open: (bodySignal) => openFileChunks({ signal: bodySignal }) }],
  multipartBoundary,
);

const uploaded = await adminV2PutCapletRecordBundleStream({
  client,
  path: { id: recordId },
  headers: { "Idempotency-Key": idempotencyKey },
  ...multipart,
});
```

The streaming upload helper sets Node Fetch's required half-duplex option. Canceling the multipart
body aborts its chunk-source signal before closing the active iterator. Abort the HTTP operation
with the operation's `signal`.

## Project Binding

The browser-safe coordinator is a separate export. It requires the exact `ws:` or `wss:` Project
Binding connect endpoint at `/api/v1/attach/project-bindings/connect`; it does not derive that
endpoint from the Current Host Origin.

```ts
import { createClient } from "@caplets/sdk";
import { runProjectBindingSession } from "@caplets/sdk/project-binding";

const client = createClient({
  baseUrl: "https://host.example",
  auth: async () => getCurrentAccessToken(),
});

const result = await runProjectBindingSession({
  client,
  webSocketUrl: "wss://host.example/api/v1/attach/project-bindings/connect",
  projectRoot: selectedProjectRoot,
  projectFingerprint,
  signal,
  onEvent(event) {
    if (event.type === "ready") showReady(event.syncState);
    if (event.type === "reconnecting") showReconnecting();
    if (event.type === "ended") showEnded(event.reason);
  },
});

if (result.error) {
  showFailure(result.error.kind, result.error.cleanup);
} else {
  showEndedProject(result.data.bindingId);
}
```

Browser callers supply a stable project fingerprint. Node.js callers can compute the marker-aware
fingerprint through the Node-only subpath, then pass it to the same browser-safe coordinator:

```ts
import { fingerprintProjectRoot } from "@caplets/sdk/project-binding/node";
import { runProjectBindingSession } from "@caplets/sdk/project-binding";

const projectRoot = process.cwd();
const projectFingerprint = fingerprintProjectRoot(projectRoot);

const result = await runProjectBindingSession({
  client,
  webSocketUrl: "wss://host.example/api/v1/attach/project-bindings/connect",
  projectRoot,
  projectFingerprint,
});
```

Events are `state`, `ready`, `reconnecting`, `heartbeat`, and `ended`. The coordinator validates
messages, sends HTTP and WebSocket heartbeats every 15 seconds, reconnects once after an unexpected
socket failure, and guards finalization so it runs once. Abort, socket, protocol, callback, HTTP,
and cleanup failures are typed `ProjectBindingSessionError` outcomes. A primary failure is preserved;
a safe secondary cleanup detail may be attached. Pass `throwOnError: true` to receive session data
directly and reject on failure.

Bearer authentication is carried in headers and WebSocket subprotocol negotiation, never in the
WebSocket URL, events, or error messages.

## Runtime scope

- Root HTTP client and `@caplets/sdk/project-binding`: modern browsers and Node.js 22+.
- `@caplets/sdk/project-binding/node`: Node.js 22+ only; it uses filesystem and crypto APIs.
- The root exposes public HTTP discovery, health, Remote Login, Attach, Project Binding controls,
  and Admin operations at their canonical `/api/*` paths.
- It does not generate well-known discovery, MCP operations, AsyncAPI clients,
  dashboard-private cookie/session/CSRF routes, Raw Vault Reveal, credential persistence, or
  automatic endpoint discovery. It does not retry requests at another path or infer a deployment
  prefix.
- Import public names from `@caplets/sdk`; generated internal paths are not API.

See the [SDK guide](https://docs.caplets.dev/sdk/) and
[Project Binding guide](https://docs.caplets.dev/project-binding/).
