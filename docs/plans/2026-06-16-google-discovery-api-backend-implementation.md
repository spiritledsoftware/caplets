# Google Discovery API Backend Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Google Discovery API backend with inferred scopes, operation filters, comprehensive media upload/download, and shared media artifact handling for HTTP-like backends.

**Architecture:** Add `googleDiscoveryApis` as a new top-level Caplets backend family with its own manager and native Google Discovery parser. Build shared media artifact infrastructure first, wire HTTP/OpenAPI responses through it, then implement Google Discovery on top of shared auth, HTTP request, and artifact primitives. Keep Google Discovery distinct from OpenAPI while returning the same Caplets `Tool` and `CompatibilityCallToolResult` shapes used by other backends.

**Tech Stack:** TypeScript, Zod, Vitest, MCP SDK `Tool`/`CompatibilityCallToolResult`, existing Caplets auth/config/engine/tool surfaces, Node filesystem and fetch APIs, pnpm 11.5.0, Node >=22.

---

## Source Documents

- Design spec: `docs/specs/2026-06-16-google-discovery-api-backend.md`
- Media ADR: `docs/adr/0002-media-artifacts-for-non-inline-results.md`
- Glossary: `CONTEXT.md`
- Existing backend references: `packages/core/src/openapi.ts`, `packages/core/src/http-actions.ts`, `packages/core/src/graphql.ts`
- Existing config references: `packages/core/src/config.ts`, `packages/core/src/caplet-files-bundle.ts`, `packages/core/src/registry.ts`

## File Structure Map

Create:

- `packages/core/src/media/artifacts.ts` — writes Caplets-managed media artifacts, resolves artifact references, computes hashes, and enforces output path safety.
- `packages/core/src/media/input.ts` — reads media input from `path`, `artifact`, or `dataUrl` for upload-capable backends.
- `packages/core/src/http/response.ts` — shared HTTP response reader that returns inline JSON/text or a Media artifact.
- `packages/core/src/google-discovery/types.ts` — narrow TypeScript types for the Google Discovery document shapes Caplets consumes.
- `packages/core/src/google-discovery/schema.ts` — converts Google Discovery schemas to JSON Schema-like tool schemas.
- `packages/core/src/google-discovery/operations.ts` — walks `resources.*.methods.*`, applies operation filters, resolves scopes, and builds operation descriptors.
- `packages/core/src/google-discovery/request.ts` — builds normal JSON requests and media upload/download requests.
- `packages/core/src/google-discovery/manager.ts` — `GoogleDiscoveryManager` implementation.
- `packages/core/src/google-discovery/index.ts` — public exports for the manager and helper types.
- `packages/core/test/google-discovery.test.ts` — parser, manager, auth, filtering, media, and tool-surface tests.
- `packages/core/test/media-artifacts.test.ts` — shared artifact and media input tests.
- `packages/core/test/fixtures/google-discovery/drive.discovery.json` — small Drive-like fixture with JSON, download, simple upload, multipart upload, resumable upload, scopes, and destructive operations.

Modify:

- `packages/core/src/config/paths.ts` — add default artifact directory export.
- `packages/core/src/config.ts` — add `GoogleDiscoveryApiConfig`, schema, normalization, merge/source/reject logic, and config JSON schema support.
- `packages/core/src/caplet-files-bundle.ts` — add `googleDiscoveryApi` frontmatter support and schema generation.
- `packages/core/src/caplet-source/parse.ts` — include Google Discovery Caplets in parsed source output.
- `packages/core/src/registry.ts` — include backend detail for `googleDiscovery`.
- `packages/core/src/engine.ts` — instantiate/update/invalidate/dispatch `GoogleDiscoveryManager`.
- `packages/core/src/tools.ts` — accept `GoogleDiscoveryManager` in `handleServerTool` and `backendFor`.
- `packages/core/src/native/service.ts` and `packages/core/src/native/tools.ts` — include Google Discovery in native service/tool guidance.
- `packages/core/src/cli/auth.ts` — include Google Discovery auth targets and resolve inferred scopes before login/refresh.
- `packages/core/src/auth.ts` and `packages/core/src/auth/store.ts` — support backend-resolved OAuth scopes and compare requested scope metadata.
- `packages/core/src/cli/add.ts` and `packages/core/src/cli.ts` — add `caplets add google-discovery`.
- `packages/core/src/cli/inspection.ts`, `packages/core/src/cli/completion-discovery.ts`, `packages/core/src/cli/setup-caplet.ts`, `packages/core/src/cli/doctor.ts` — include `googleDiscoveryApis` anywhere all Caplets are enumerated.
- `packages/core/src/remote-control/dispatch.ts` and remote add types if remote add kinds are enumerated there.
- `packages/core/src/openapi.ts` and `packages/core/src/http-actions.ts` — use shared response/artifact reader.
- `packages/core/src/code-mode/runtime-api.d.ts` and generated output only if media artifact types are added to Code Mode declarations.
- `schemas/caplets-config.schema.json`, `schemas/caplet.schema.json`, and docs generated from config/caplet schemas.
- `apps/docs/src/content/docs/reference/config.mdx`, `apps/docs/src/content/docs/reference/caplet-files.mdx`, `apps/docs/src/content/docs/capabilities.mdx`, `apps/docs/src/content/docs/troubleshooting.mdx`, `apps/docs/src/content/docs/changelog.mdx`.
- `docs/architecture.md` — add Google Discovery to backend families and HTTP-like backend contract.

## Implementation Tasks

### Task 1: Shared Media Artifact Infrastructure

**Files:**

- Create: `packages/core/src/media/artifacts.ts`
- Create: `packages/core/src/media/input.ts`
- Modify: `packages/core/src/config/paths.ts`
- Test: `packages/core/test/media-artifacts.test.ts`

- [ ] **Step 1: Write failing artifact tests**

Create `packages/core/test/media-artifacts.test.ts` with these cases:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMediaInput, resolveMediaArtifact, writeMediaArtifact } from "../src/media";

describe("media artifacts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it("writes artifact files with stable metadata", async () => {
    const root = tempDir("caplets-artifacts-");
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "google-drive",
      suggestedFilename: "report.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("pdf-bytes"),
    });

    expect(artifact).toMatchObject({
      mimeType: "application/pdf",
      byteLength: 9,
      filename: "report.pdf",
    });
    expect(artifact.path).toContain(join(root, "google-drive"));
    expect(artifact.sha256).toHaveLength(64);
    expect(readFileSync(artifact.path, "utf8")).toBe("pdf-bytes");
  });

  it("rejects output paths outside an allowed root", async () => {
    const root = tempDir("caplets-artifacts-");
    await expect(
      writeMediaArtifact({
        rootDir: root,
        capletId: "drive",
        outputPath: join(root, "..", "escape.bin"),
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("reads media input from path, artifact reference, and data URL", async () => {
    const root = tempDir("caplets-artifacts-");
    const file = join(root, "image.png");
    writeFileSync(file, Buffer.from("png"));
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      suggestedFilename: "existing.png",
      mimeType: "image/png",
      bytes: Buffer.from("artifact"),
    });

    await expect(readMediaInput({ path: file }, { artifactRoot: root })).resolves.toMatchObject({
      bytes: Buffer.from("png"),
      filename: "image.png",
    });
    await expect(
      readMediaInput({ artifact: artifact.uri }, { artifactRoot: root }),
    ).resolves.toMatchObject({
      bytes: Buffer.from("artifact"),
      filename: "existing.png",
      mimeType: "image/png",
    });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain;base64,aGVsbG8=", filename: "hello.txt" },
        { artifactRoot: root },
      ),
    ).resolves.toMatchObject({
      bytes: Buffer.from("hello"),
      filename: "hello.txt",
      mimeType: "text/plain",
    });
  });

  it("rejects multiple media input sources and non-base64 data URLs", async () => {
    const root = tempDir("caplets-artifacts-");
    await expect(
      readMediaInput(
        { path: "/tmp/a", dataUrl: "data:text/plain;base64,eA==" },
        {
          artifactRoot: root,
        },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain,hello" },
        {
          artifactRoot: root,
        },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
});
```

- [ ] **Step 2: Run the failing artifact tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/media-artifacts.test.ts
```

Expected: fails because `../src/media` does not exist.

- [ ] **Step 3: Add default artifact path**

In `packages/core/src/config/paths.ts`, export a default artifact directory next to existing state/cache directory exports:

```ts
export const DEFAULT_ARTIFACT_DIR = join(defaultStateBaseDir(), "artifacts");
```

Use the existing local naming style in the file. If the file exposes helper functions rather than constants for nearby paths, match that shape with `defaultArtifactDir()`.

- [ ] **Step 4: Implement artifact writing and lookup**

Create `packages/core/src/media/artifacts.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_ARTIFACT_DIR } from "../config/paths";
import { CapletsError } from "../errors";

export type MediaArtifact = {
  uri: string;
  path: string;
  filename: string;
  mimeType?: string;
  byteLength: number;
  sha256: string;
};

export type WriteMediaArtifactInput = {
  rootDir?: string;
  capletId: string;
  callId?: string;
  suggestedFilename?: string;
  outputPath?: string;
  mimeType?: string;
  bytes: Uint8Array | Buffer;
};

export function artifactUri(capletId: string, callId: string, filename: string): string {
  return `caplets://artifacts/${encodeURIComponent(capletId)}/${encodeURIComponent(callId)}/${encodeURIComponent(filename)}`;
}

export async function writeMediaArtifact(input: WriteMediaArtifactInput): Promise<MediaArtifact> {
  const rootDir = resolve(input.rootDir ?? DEFAULT_ARTIFACT_DIR);
  const callId =
    input.callId ?? `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  const filename = safeFilename(input.suggestedFilename ?? "response.bin");
  const target = input.outputPath
    ? assertInsideRoot(rootDir, input.outputPath)
    : resolve(rootDir, input.capletId, callId, filename);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(input.bytes);
  writeFileSync(target, bytes, { mode: 0o600 });
  return {
    uri: artifactUri(input.capletId, callId, basename(target)),
    path: target,
    filename: basename(target),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function resolveMediaArtifact(
  uri: string,
  options: { artifactRoot?: string } = {},
): MediaArtifact {
  const parsed = parseArtifactUri(uri);
  const rootDir = resolve(options.artifactRoot ?? DEFAULT_ARTIFACT_DIR);
  const path = resolve(rootDir, parsed.capletId, parsed.callId, parsed.filename);
  assertInsideRoot(rootDir, path);
  if (!existsSync(path)) {
    throw new CapletsError("REQUEST_INVALID", `Media artifact ${uri} was not found`);
  }
  const bytes = readFileSync(path);
  return {
    uri,
    path,
    filename: basename(path),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function parseArtifactUri(uri: string): { capletId: string; callId: string; filename: string } {
  const url = new URL(uri);
  if (url.protocol !== "caplets:" || url.hostname !== "artifacts") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Media artifact URI must start with caplets://artifacts/",
    );
  }
  const [capletId, callId, filename] = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (!capletId || !callId || !filename) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact URI is missing required parts");
  }
  return { capletId, callId, filename: safeFilename(filename) };
}

function assertInsideRoot(rootDir: string, candidate: string): string {
  if (!isAbsolute(candidate)) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact outputPath must be absolute");
  }
  const resolved = resolve(candidate);
  const rel = relative(rootDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Media artifact outputPath must stay inside the artifact root",
    );
  }
  return resolved;
}

function safeFilename(value: string): string {
  const name = basename(value)
    .replace(/[^\w.\- ]/gu, "_")
    .trim();
  return name || "response.bin";
}
```

- [ ] **Step 5: Implement media input reading**

Create `packages/core/src/media/input.ts`:

```ts
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { CapletsError } from "../errors";
import { resolveMediaArtifact } from "./artifacts";

export type MediaInput =
  | { path: string; artifact?: never; dataUrl?: never; filename?: string; mimeType?: string }
  | { artifact: string; path?: never; dataUrl?: never; filename?: string; mimeType?: string }
  | { dataUrl: string; path?: never; artifact?: never; filename?: string; mimeType?: string };

export type ResolvedMediaInput = {
  bytes: Buffer;
  filename: string;
  mimeType?: string;
};

export async function readMediaInput(
  input: unknown,
  options: { artifactRoot?: string; maxBytes?: number } = {},
): Promise<ResolvedMediaInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CapletsError("REQUEST_INVALID", "media must be an object");
  }
  const media = input as Record<string, unknown>;
  const sources = ["path", "artifact", "dataUrl"].filter((key) => typeof media[key] === "string");
  if (sources.length !== 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "media must define exactly one of path, artifact, or dataUrl",
    );
  }
  const filename = typeof media.filename === "string" ? media.filename : undefined;
  const mimeType = typeof media.mimeType === "string" ? media.mimeType : undefined;
  if (typeof media.path === "string") {
    const stat = statSync(media.path);
    enforceSize(stat.size, options.maxBytes);
    const bytes = readFileSync(media.path);
    return { bytes, filename: filename ?? basename(media.path), ...(mimeType ? { mimeType } : {}) };
  }
  if (typeof media.artifact === "string") {
    const artifact = resolveMediaArtifact(media.artifact, { artifactRoot: options.artifactRoot });
    enforceSize(artifact.byteLength, options.maxBytes);
    const bytes = readFileSync(artifact.path);
    return {
      bytes,
      filename: filename ?? artifact.filename,
      ...((mimeType ?? artifact.mimeType) ? { mimeType: mimeType ?? artifact.mimeType } : {}),
    };
  }
  return readDataUrl(String(media.dataUrl), { filename, mimeType, maxBytes: options.maxBytes });
}

function readDataUrl(
  dataUrl: string,
  options: { filename?: string; mimeType?: string; maxBytes?: number },
): ResolvedMediaInput {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl);
  if (!match) {
    throw new CapletsError("REQUEST_INVALID", "media.dataUrl must be a base64 data URL");
  }
  const bytes = Buffer.from(match[2]!, "base64");
  enforceSize(bytes.byteLength, options.maxBytes);
  return {
    bytes,
    filename: options.filename ?? "media.bin",
    mimeType: options.mimeType ?? match[1],
  };
}

function enforceSize(size: number, maxBytes = 100 * 1024 * 1024): void {
  if (size > maxBytes) {
    throw new CapletsError("REQUEST_INVALID", `media exceeds byte limit ${maxBytes}`);
  }
}
```

- [ ] **Step 6: Add media barrel export**

Create `packages/core/src/media/index.ts`:

```ts
export * from "./artifacts";
export * from "./input";
```

- [ ] **Step 7: Run artifact tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/media-artifacts.test.ts
```

Expected: pass.

### Task 2: Shared HTTP Response Reader And Existing Backend Media Artifacts

**Files:**

- Create: `packages/core/src/http/response.ts`
- Modify: `packages/core/src/openapi.ts`
- Modify: `packages/core/src/http-actions.ts`
- Test: `packages/core/test/openapi.test.ts`
- Test: `packages/core/test/http-actions.test.ts`

- [ ] **Step 1: Add failing HTTP/OpenAPI artifact tests**

In `packages/core/test/http-actions.test.ts`, extend the local server with:

```ts
if (request.url === "/pdf") {
  response.setHeader("content-type", "application/pdf");
  response.end(Buffer.from("%PDF-1.7 test"));
  return;
}
```

Add this test:

```ts
it("writes binary HTTP responses as media artifacts", async () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "caplets-http-artifacts-"));
  try {
    const manager = new HttpActionManager(registry(), { artifactDir });
    const api = httpApi({ actions: { pdf: { method: "GET", path: "/pdf" } } });

    const result = await manager.callTool(api, "pdf", {});

    expect(result.structuredContent).toMatchObject({
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: {
        artifact: {
          mimeType: "application/pdf",
          byteLength: 13,
        },
      },
    });
    const path = (result.structuredContent as any).body.artifact.path;
    expect(readFileSync(path, "utf8")).toBe("%PDF-1.7 test");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});
```

Mirror the same assertion in `packages/core/test/openapi.test.ts` using an OpenAPI operation whose response has `application/pdf`.

- [ ] **Step 2: Run failing existing-backend media tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/http-actions.test.ts test/openapi.test.ts
```

Expected: fail because responses are still read as bounded text.

- [ ] **Step 3: Implement shared response reader**

Create `packages/core/src/http/response.ts`:

```ts
import type { MediaArtifact } from "../media";
import { writeMediaArtifact } from "../media";
import { parseHttpBody, readLimitedText } from "./utils";

export type HttpLikeResponseBody =
  | { body?: unknown; artifact?: never }
  | { body: { artifact: MediaArtifact } };

export type ReadHttpLikeResponseOptions = {
  capletId: string;
  artifactDir?: string;
  outputPath?: string;
  filename?: string;
  maxInlineBytes?: number;
};

export async function readHttpLikeResponse(
  response: Response,
  options: ReadHttpLikeResponseOptions,
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0]?.toLowerCase().trim() ?? "";
  const inlineText = isInlineTextMime(mime);
  if (inlineText) {
    try {
      const text = await readLimitedText(response, {
        maxBytes: options.maxInlineBytes,
        errorMessage: "HTTP response exceeded inline byte limit",
      });
      const body = parseHttpBody(contentType, text);
      return baseResponse(response, contentType, body);
    } catch (error) {
      if (!response.body) throw error;
    }
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const artifact = await writeMediaArtifact({
    rootDir: options.artifactDir,
    capletId: options.capletId,
    outputPath: options.outputPath,
    suggestedFilename: options.filename ?? filenameFromHeaders(response) ?? "response.bin",
    mimeType: mime || undefined,
    bytes,
  });
  return baseResponse(response, contentType, { artifact });
}

function baseResponse(
  response: Response,
  contentType: string,
  body: unknown,
): Record<string, unknown> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": contentType },
    ...(body === undefined ? {} : { body }),
  };
}

function isInlineTextMime(mime: string): boolean {
  return (
    mime === "" ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime.endsWith("/json") ||
    mime.startsWith("text/")
  );
}

function filenameFromHeaders(response: Response): string | undefined {
  const disposition = response.headers.get("content-disposition") ?? "";
  return /filename="?([^";]+)"?/iu.exec(disposition)?.[1];
}
```

- [ ] **Step 4: Pass artifact options through managers**

Update constructors in `packages/core/src/http-actions.ts` and `packages/core/src/openapi.ts`:

```ts
constructor(
  private registry: ServerRegistry,
  private readonly options: { authDir?: string; artifactDir?: string } = {},
) {}
```

Replace local `readResponse` functions with calls to `readHttpLikeResponse(response, { capletId, artifactDir })`.

For OpenAPI and HTTP actions, reserve `args.outputPath` and `args.filename` for artifact output by removing them from request query/body/path mappings only when the operation schema explicitly models them as media output controls. If this conflicts with existing actions, keep output controls under `_caplets: { outputPath, filename }` and document that path in the plan implementation notes.

- [ ] **Step 5: Pass artifact directory from engine**

Add `artifactDir?: string` to `CapletsEngineOptions`. Instantiate managers with:

```ts
const sharedManagerOptions = { authDir: options.authDir, artifactDir: options.artifactDir };
this.openapi = new OpenApiManager(this.registry, sharedManagerOptions);
this.graphql = new GraphQLManager(this.registry, selectAuthOptions(options.authDir));
this.http = new HttpActionManager(this.registry, sharedManagerOptions);
```

GraphQL can remain text/JSON-only unless the implementation chooses to route it through the shared reader.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/media-artifacts.test.ts test/http-actions.test.ts test/openapi.test.ts
```

Expected: pass.

### Task 3: Config Schema And Core Types For `googleDiscoveryApis`

**Files:**

- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/registry.ts`
- Test: `packages/core/test/config.test.ts`

- [ ] **Step 1: Add failing config tests**

Add to `packages/core/test/config.test.ts`:

```ts
it("loads Google Discovery APIs with defaults and safe registry details", () => {
  const config = parseConfig({
    googleDiscoveryApis: {
      drive: {
        name: "Google Drive",
        description: "Access Google Drive files and permissions.",
        discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
        auth: { type: "oidc", issuer: "https://accounts.google.com", clientId: "client" },
        includeOperations: ["drive.files.*"],
        excludeOperations: ["drive.files.delete"],
      },
    },
  });
  expect(config.googleDiscoveryApis.drive).toMatchObject({
    server: "drive",
    backend: "googleDiscovery",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    requestTimeoutMs: 60000,
    operationCacheTtlMs: 30000,
    disabled: false,
  });
  expect(JSON.stringify(configJsonSchema())).toContain("googleDiscoveryApis");
});

it("rejects invalid Google Discovery sources and duplicate Caplet IDs", () => {
  expect(() =>
    parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Drive",
          description: "Access Google Drive files.",
          discoveryUrl: "ftp://example.com/discovery.json",
          auth: { type: "none" },
        },
      },
    }),
  ).toThrow(CapletsError);
  expect(() =>
    parseConfig({
      openapiEndpoints: {
        drive: {
          name: "Drive OpenAPI",
          description: "OpenAPI Drive wrapper.",
          specUrl: "https://example.com/openapi.json",
          auth: { type: "none" },
        },
      },
      googleDiscoveryApis: {
        drive: {
          name: "Drive",
          description: "Access Google Drive files.",
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
          auth: { type: "none" },
        },
      },
    }),
  ).toThrow(/already used/);
});
```

- [ ] **Step 2: Run failing config tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/config.test.ts
```

Expected: fail because config does not know `googleDiscoveryApis`.

- [ ] **Step 3: Add config types**

In `packages/core/src/config.ts`, add:

```ts
export type GoogleDiscoveryApiConfig = AgentSelectionHintsConfig & {
  server: string;
  backend: "googleDiscovery";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  tags?: string[] | undefined;
  body?: string | undefined;
  discoveryPath?: string | undefined;
  discoveryUrl?: string | undefined;
  baseUrl?: string | undefined;
  includeOperations?: string[] | undefined;
  excludeOperations?: string[] | undefined;
  auth: OpenApiAuthConfig;
  requestTimeoutMs: number;
  operationCacheTtlMs: number;
  disabled: boolean;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
};
```

Extend:

```ts
export type CapletConfig =
  | CapletServerConfig
  | OpenApiEndpointConfig
  | GoogleDiscoveryApiConfig
  | GraphQlEndpointConfig
  | HttpApiConfig
  | CliToolsConfig
  | CapletSetConfig;

export type CapletsConfig = {
  ...
  googleDiscoveryApis: Record<string, GoogleDiscoveryApiConfig>;
  ...
};
```

- [ ] **Step 4: Add Zod schema**

Add `publicGoogleDiscoveryApiSchema` modeled after `publicOpenApiEndpointSchema`:

```ts
const operationFilterSchema = z.array(z.string().trim().min(1).max(160));

const publicGoogleDiscoveryApiSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe("Human-readable Google Discovery API display name."),
    description: z
      .string()
      .describe(
        "Capability description shown to agents before Google Discovery operations are disclosed.",
      )
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
    discoveryPath: z.string().min(1).optional().describe("Local Google Discovery document path."),
    discoveryUrl: z.string().url().optional().describe("Remote Google Discovery document URL."),
    baseUrl: z.string().url().optional().describe("Override base URL for Google API requests."),
    includeOperations: operationFilterSchema.optional(),
    excludeOperations: operationFilterSchema.optional(),
    auth: openApiAuthSchema.describe(
      'Explicit Google API request auth config. Use {"type":"none"} for public APIs.',
    ),
    tags: z.array(z.string().trim().min(1).max(80)).optional(),
    exposure: exposureSchema.optional(),
    shadowing: shadowingSchema,
    ...agentSelectionHintsSchema,
    setup: setupSchema.optional(),
    projectBinding: projectBindingSchema.optional(),
    runtime: runtimeRequirementsSchema.optional(),
    requestTimeoutMs: z.number().int().positive().default(60_000),
    operationCacheTtlMs: z.number().int().nonnegative().default(30_000),
    disabled: z.boolean().default(false),
  })
  .strict();
```

Normalize parsed entries with `server` and `backend: "googleDiscovery"` the same way OpenAPI entries are normalized.

- [ ] **Step 5: Add validation, merge, source, and project rejection support**

Update every backend-map list in `packages/core/src/config.ts`:

- `ConfigInput`
- `configSchemaFor(...)`
- duplicate ID checks
- URL safety checks for `discoveryUrl` and `baseUrl`
- exact-one-source check for `discoveryPath` xor `discoveryUrl`
- `normalizeLocalPaths`
- `rejectProjectConfigExecutableBackendMaps`
- `mergeConfigInputs`
- `removeCapletId`
- `capletIds`
- empty-config checks

Use this duplicate ordering when checking `googleDiscoveryApis`: `mcpServers`, `openapiEndpoints`, then `googleDiscoveryApis`, then the remaining backend maps.

- [ ] **Step 6: Update registry detail**

In `packages/core/src/registry.ts`, add a backend detail variant:

```ts
| {
    type: "googleDiscovery";
    disabled: boolean;
    requestTimeoutMs: number;
    operationCacheTtlMs: number;
    source: "discoveryPath" | "discoveryUrl";
  }
```

Add `googleDiscoveryApis` to `get()`, `allCaplets()`, and `backendDetail()`.

- [ ] **Step 7: Run config tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/config.test.ts
```

Expected: pass.

### Task 4: Caplet Files, Source Parsing, Inspection, And CLI Enumeration

**Files:**

- Modify: `packages/core/src/caplet-files-bundle.ts`
- Modify: `packages/core/src/caplet-source/parse.ts`
- Modify: `packages/core/src/cli/inspection.ts`
- Modify: `packages/core/src/cli/completion-discovery.ts`
- Modify: `packages/core/src/cli/setup-caplet.ts`
- Modify: `packages/core/src/cli/doctor.ts`
- Modify: `packages/core/src/cli.ts`
- Test: `packages/core/test/caplet-files.test.ts`
- Test: `packages/core/test/config.test.ts`
- Test: `packages/core/test/cli.test.ts`

- [ ] **Step 1: Add failing Caplet file and list tests**

In `packages/core/test/caplet-files.test.ts`:

```ts
it("loads Google Discovery API backend Caplet files", () => {
  const result = loadCapletFilesFromMap({
    files: [
      {
        path: "drive/CAPLET.md",
        content: `---
name: Google Drive
description: Access Google Drive files.
googleDiscoveryApi:
  discoveryPath: ./drive.discovery.json
  includeOperations:
    - drive.files.*
  auth:
    type: none
---

# Drive
`,
      },
    ],
  });

  expect(result?.config.googleDiscoveryApis?.drive).toEqual(
    expect.objectContaining({
      name: "Google Drive",
      description: "Access Google Drive files.",
      discoveryPath: "drive/drive.discovery.json",
      includeOperations: ["drive.files.*"],
      body: "\n# Drive\n",
    }),
  );
});
```

In `packages/core/test/cli.test.ts`, add a list/inspect assertion using `googleDiscoveryApis` and expect backend `googleDiscovery`.

- [ ] **Step 2: Run failing tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/caplet-files.test.ts test/cli.test.ts
```

Expected: fail because file loading and listing do not include the new backend.

- [ ] **Step 3: Add frontmatter schema**

In `packages/core/src/caplet-files-bundle.ts`, add `capletGoogleDiscoveryApiSchema` with the same fields as config minus top-level display fields, add `googleDiscoveryApi` to `capletFileSchema`, and update the backend-count error text:

```ts
"Caplet file must define exactly one backend: mcpServer, openapiEndpoint, googleDiscoveryApi, graphqlEndpoint, httpApi, cliTools, or capletSet";
```

- [ ] **Step 4: Add Google Discovery file mapping**

In `buildCapletFileLoadResultFromEntries`, add `googleDiscoveryApis` to duplicate detection and output config. In the frontmatter normalization function, add:

```ts
if (frontmatter.googleDiscoveryApi) {
  return {
    ...frontmatter.googleDiscoveryApi,
    discoveryPath: normalizePath(frontmatter.googleDiscoveryApi.discoveryPath, baseDir),
    backend: "googleDiscovery",
    name: frontmatter.name,
    description: frontmatter.description,
    ...sharedCapletFields(frontmatter),
    body,
  };
}
```

- [ ] **Step 5: Add enumeration support**

Add `googleDiscoveryApis` to all `allCaplets` or object-spread collections in:

- `packages/core/src/caplet-source/parse.ts`
- `packages/core/src/cli/inspection.ts`
- `packages/core/src/cli/completion-discovery.ts`
- `packages/core/src/cli/setup-caplet.ts`
- `packages/core/src/cli/doctor.ts`
- `packages/core/src/cli.ts` `capletConfigKinds`, `hasEnabledCaplet`, and any local overlay removal helpers

- [ ] **Step 6: Run file/list tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/caplet-files.test.ts test/config.test.ts test/cli.test.ts
```

Expected: pass.

### Task 5: Google Discovery Parser, Schema Conversion, Filtering, And Scope Resolution

**Files:**

- Create: `packages/core/src/google-discovery/types.ts`
- Create: `packages/core/src/google-discovery/schema.ts`
- Create: `packages/core/src/google-discovery/operations.ts`
- Create: `packages/core/src/google-discovery/index.ts`
- Create: `packages/core/test/fixtures/google-discovery/drive.discovery.json`
- Test: `packages/core/test/google-discovery.test.ts`

- [ ] **Step 1: Add a compact Drive-like fixture**

Create `packages/core/test/fixtures/google-discovery/drive.discovery.json` with this shape:

```json
{
  "kind": "discovery#restDescription",
  "id": "drive:v3",
  "name": "drive",
  "version": "v3",
  "title": "Drive API",
  "rootUrl": "https://www.googleapis.com/",
  "servicePath": "drive/v3/",
  "baseUrl": "https://www.googleapis.com/drive/v3/",
  "auth": {
    "oauth2": {
      "scopes": {
        "https://www.googleapis.com/auth/drive": { "description": "Full Drive access." },
        "https://www.googleapis.com/auth/drive.readonly": { "description": "Read Drive files." }
      }
    }
  },
  "parameters": {
    "fields": {
      "type": "string",
      "location": "query",
      "description": "Partial response selector."
    },
    "prettyPrint": { "type": "boolean", "location": "query", "default": "true" }
  },
  "schemas": {
    "File": {
      "id": "File",
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" },
        "parents": { "type": "array", "items": { "type": "string" } }
      }
    },
    "FileList": {
      "id": "FileList",
      "type": "object",
      "properties": {
        "files": { "type": "array", "items": { "$ref": "File" } },
        "nextPageToken": { "type": "string" }
      }
    }
  },
  "resources": {
    "files": {
      "methods": {
        "list": {
          "id": "drive.files.list",
          "path": "files",
          "httpMethod": "GET",
          "description": "Lists files.",
          "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
          "parameters": {
            "pageSize": {
              "type": "integer",
              "format": "int32",
              "location": "query",
              "default": "100"
            }
          },
          "response": { "$ref": "FileList" }
        },
        "delete": {
          "id": "drive.files.delete",
          "path": "files/{fileId}",
          "httpMethod": "DELETE",
          "description": "Permanently deletes a file.",
          "parameters": {
            "fileId": { "type": "string", "location": "path", "required": true }
          },
          "scopes": ["https://www.googleapis.com/auth/drive"]
        },
        "create": {
          "id": "drive.files.create",
          "path": "files",
          "httpMethod": "POST",
          "description": "Creates a file.",
          "request": { "$ref": "File" },
          "response": { "$ref": "File" },
          "scopes": ["https://www.googleapis.com/auth/drive"],
          "supportsMediaUpload": true,
          "mediaUpload": {
            "protocols": {
              "simple": { "path": "/upload/drive/v3/files", "multipart": false },
              "multipart": { "path": "/upload/drive/v3/files", "multipart": true },
              "resumable": { "path": "/upload/drive/v3/files", "multipart": true }
            }
          }
        },
        "download": {
          "id": "drive.files.download",
          "path": "files/{fileId}/download",
          "httpMethod": "GET",
          "description": "Downloads file media.",
          "supportsMediaDownload": true,
          "parameters": {
            "fileId": { "type": "string", "location": "path", "required": true }
          },
          "scopes": ["https://www.googleapis.com/auth/drive.readonly"]
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write failing parser tests**

In `packages/core/test/google-discovery.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoveryOperations, googleDiscoveryScopesForOperations } from "../src/google-discovery";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/google-discovery/drive.discovery.json"), "utf8"),
);

describe("Google Discovery parser", () => {
  it("maps resources and methods to Caplets operations", () => {
    const operations = discoveryOperations({
      server: "drive",
      document: fixture,
      includeOperations: ["drive.files.*"],
      excludeOperations: ["drive.files.delete"],
    });

    expect(operations.map((operation) => operation.name)).toEqual([
      "drive.files.create",
      "drive.files.download",
      "drive.files.list",
    ]);
    expect(operations.find((operation) => operation.name === "drive.files.list")).toMatchObject({
      method: "get",
      path: "files",
      readOnlyHint: true,
      destructiveHint: false,
      inputSchema: {
        properties: {
          query: {
            properties: {
              fields: { type: "string" },
              pageSize: { type: "integer", default: 100 },
            },
          },
        },
      },
    });
  });

  it("marks destructive operations and resolves filtered scopes", () => {
    const operations = discoveryOperations({ server: "drive", document: fixture });
    expect(operations.find((operation) => operation.name === "drive.files.delete")).toMatchObject({
      destructiveHint: true,
    });
    expect(googleDiscoveryScopesForOperations(operations)).toEqual([
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
  });
});
```

- [ ] **Step 3: Run failing parser tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts
```

Expected: fail because parser files do not exist.

- [ ] **Step 4: Implement types**

Create `packages/core/src/google-discovery/types.ts`:

```ts
export type GoogleDiscoveryDocument = {
  kind?: string;
  id?: string;
  name?: string;
  version?: string;
  title?: string;
  rootUrl?: string;
  servicePath?: string;
  baseUrl?: string;
  auth?: { oauth2?: { scopes?: Record<string, { description?: string }> } };
  parameters?: Record<string, GoogleDiscoveryParameter>;
  schemas?: Record<string, GoogleDiscoverySchema>;
  resources?: Record<string, GoogleDiscoveryResource>;
};

export type GoogleDiscoveryResource = {
  methods?: Record<string, GoogleDiscoveryMethod>;
  resources?: Record<string, GoogleDiscoveryResource>;
};

export type GoogleDiscoveryMethod = {
  id?: string;
  path?: string;
  flatPath?: string;
  httpMethod?: string;
  description?: string;
  parameters?: Record<string, GoogleDiscoveryParameter>;
  parameterOrder?: string[];
  request?: { $ref?: string };
  response?: { $ref?: string };
  scopes?: string[];
  supportsMediaUpload?: boolean;
  supportsMediaDownload?: boolean;
  mediaUpload?: {
    accept?: string[];
    maxSize?: string;
    protocols?: Record<string, { path?: string; multipart?: boolean }>;
  };
};

export type GoogleDiscoveryParameter = GoogleDiscoverySchema & {
  location?: "path" | "query" | "header";
  required?: boolean;
  repeated?: boolean;
  deprecated?: boolean;
};

export type GoogleDiscoverySchema = {
  id?: string;
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  repeated?: boolean;
  properties?: Record<string, GoogleDiscoverySchema>;
  items?: GoogleDiscoverySchema;
  additionalProperties?: GoogleDiscoverySchema;
};
```

- [ ] **Step 5: Implement schema conversion**

Create `packages/core/src/google-discovery/schema.ts` with:

```ts
import type { GoogleDiscoverySchema } from "./types";

export function googleDiscoverySchemaToJsonSchema(
  value: GoogleDiscoverySchema | undefined,
  schemas: Record<string, GoogleDiscoverySchema> = {},
  seen = new Set<string>(),
): Record<string, unknown> {
  if (!value) return {};
  if (value.$ref) {
    const target = schemas[value.$ref];
    if (!target || seen.has(value.$ref)) return { type: "object", additionalProperties: true };
    return googleDiscoverySchemaToJsonSchema(target, schemas, new Set([...seen, value.$ref]));
  }
  const type = value.type === "any" ? "object" : value.type;
  const converted: Record<string, unknown> = {};
  if (value.description) converted.description = collapseWhitespace(value.description);
  if (type) converted.type = type;
  if (value.format) converted.format = value.format;
  if (value.enum) converted.enum = value.enum;
  const defaultValue = convertedDefault(value.default, type);
  if (defaultValue !== undefined) converted.default = defaultValue;
  if (value.repeated) {
    return {
      ...(converted.description ? { description: converted.description } : {}),
      type: "array",
      items: omit(converted, ["description", "default"]),
    };
  }
  if (value.items) converted.items = googleDiscoverySchemaToJsonSchema(value.items, schemas, seen);
  if (value.properties) {
    converted.type = converted.type ?? "object";
    converted.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, schema]) => [
        key,
        googleDiscoverySchemaToJsonSchema(schema, schemas, seen),
      ]),
    );
    converted.additionalProperties = false;
  }
  if (value.additionalProperties) {
    converted.additionalProperties = googleDiscoverySchemaToJsonSchema(
      value.additionalProperties,
      schemas,
      seen,
    );
  }
  return converted;
}

function convertedDefault(value: unknown, type: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (type === "boolean" && typeof value === "string") return value === "true";
  if ((type === "integer" || type === "number") && typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  return value;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function omit(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
```

- [ ] **Step 6: Implement operation mapping**

Create `packages/core/src/google-discovery/operations.ts` with exported `GoogleDiscoveryOperation`, `discoveryOperations`, `googleDiscoveryScopesForOperations`, and glob matching. The operation type must carry:

```ts
export type GoogleDiscoveryOperation = {
  name: string;
  method: "get" | "put" | "post" | "delete" | "patch";
  path: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  scopes: string[];
  supportsMediaUpload: boolean;
  supportsMediaDownload: boolean;
  mediaUploadProtocols: Record<string, { path?: string; multipart?: boolean }>;
};
```

Use `method.id` as the operation name. Sort operations by name. Use path parameters as required. Apply include/exclude patterns against operation names before returning.

- [ ] **Step 7: Export parser helpers and run tests**

Create `packages/core/src/google-discovery/index.ts`:

```ts
export * from "./types";
export * from "./schema";
export * from "./operations";
```

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts
```

Expected: parser tests pass.

### Task 6: `GoogleDiscoveryManager` For Discovery, Descriptors, Search, And JSON Calls

**Files:**

- Create: `packages/core/src/google-discovery/request.ts`
- Create: `packages/core/src/google-discovery/manager.ts`
- Modify: `packages/core/src/google-discovery/index.ts`
- Test: `packages/core/test/google-discovery.test.ts`

- [ ] **Step 1: Extend fixture server tests**

In `packages/core/test/google-discovery.test.ts`, add a local HTTP server similar to `openapi.test.ts` that serves `/drive.discovery.json`, `/drive/v3/files`, `/drive/v3/files/{fileId}`, and JSON responses. Add a test:

```ts
it("lists, describes, searches, and calls Google Discovery operations", async () => {
  const config = parseConfig({
    googleDiscoveryApis: {
      drive: {
        name: "Google Drive",
        description: "Access Google Drive files.",
        discoveryUrl: `${baseUrl}/drive.discovery.json`,
        baseUrl: `${baseUrl}/drive/v3/`,
        auth: { type: "none" },
        includeOperations: ["drive.files.*"],
        excludeOperations: ["drive.files.delete"],
      },
    },
  });
  const registry = new ServerRegistry(config);
  const manager = new GoogleDiscoveryManager(registry);
  const caplet = config.googleDiscoveryApis.drive!;

  await expect(manager.listTools(caplet)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "drive.files.list" }),
      expect.objectContaining({ name: "drive.files.create" }),
    ]),
  );
  await expect(manager.getTool(caplet, "drive.files.list")).resolves.toMatchObject({
    inputSchema: { properties: { query: { properties: { pageSize: { type: "integer" } } } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
  });
  await expect(
    manager.callTool(caplet, "drive.files.list", { query: { pageSize: 2 } }),
  ).resolves.toMatchObject({
    structuredContent: { status: 200, body: { files: [{ id: "1", name: "Report" }] } },
    isError: false,
  });
});
```

- [ ] **Step 2: Run failing manager tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts
```

Expected: fail because `GoogleDiscoveryManager` is not implemented.

- [ ] **Step 3: Implement request builder**

Create `packages/core/src/google-discovery/request.ts` with functions:

```ts
export function buildGoogleDiscoveryUrl(
  api: GoogleDiscoveryApiConfig,
  operation: GoogleDiscoveryOperation,
  args: Record<string, unknown>,
): URL;

export function buildJsonRequestInit(
  operation: GoogleDiscoveryOperation,
  args: Record<string, unknown>,
  headers: Headers,
): RequestInit;
```

Rules:

- Preserve base URL path like OpenAPI `buildOperationUrl`.
- Substitute `{path}` params from `args.path`.
- Append query params from `args.query`.
- Reject object/array query and path values.
- Set `content-type: application/json` only when `args.body` is present.
- Reject attempts to supply forbidden headers through args.

- [ ] **Step 4: Implement manager skeleton**

Create `packages/core/src/google-discovery/manager.ts` with the same public method shape as `OpenApiManager`:

```ts
export class GoogleDiscoveryManager {
  constructor(
    private registry: ServerRegistry,
    private readonly options: { authDir?: string; artifactDir?: string } = {},
  ) {}

  updateRegistry(registry: ServerRegistry): void;
  invalidate(serverId: string): void;
  checkApi(api: GoogleDiscoveryApiConfig): Promise<{
    id: string;
    status: string;
    toolCount?: number;
    elapsedMs: number;
    error?: unknown;
  }>;
  listTools(api: GoogleDiscoveryApiConfig): Promise<Tool[]>;
  getTool(api: GoogleDiscoveryApiConfig, toolName: string): Promise<Tool>;
  callTool(
    api: GoogleDiscoveryApiConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult>;
  compact(api: GoogleDiscoveryApiConfig, tool: Tool): CompactTool;
  search(api: GoogleDiscoveryApiConfig, tools: Tool[], query: string, limit: number): CompactTool[];
  resolveAuthScopes(api: GoogleDiscoveryApiConfig): Promise<string[]>;
}
```

Cache parsed operations by server and source cache key. Load source from `discoveryPath` or `discoveryUrl`, reject redirects, enforce request timeout, parse JSON, and validate `kind === "discovery#restDescription"` or presence of `resources` plus `schemas`.

- [ ] **Step 5: Implement JSON call path**

In `callTool`, for operations without media upload/download:

1. Build URL.
2. Apply auth via `genericOAuthHeaders(api as GenericAuthTarget, authDir)` or static auth helpers.
3. Fetch with `redirect: "manual"`.
4. Reject redirects.
5. Use `readHttpLikeResponse(response, { capletId: api.server, artifactDir: this.options.artifactDir })`.
6. Return `content`, `structuredContent`, and `isError: !response.ok`.

- [ ] **Step 6: Run manager tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts
```

Expected: pass for parser and JSON manager tests.

### Task 7: Engine, Tool, Native, Direct Exposure, And Code Mode Integration

**Files:**

- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/native/service.ts`
- Modify: `packages/core/src/native/tools.ts`
- Modify: `packages/core/src/exposure/discovery.ts` only if type narrowing requires it
- Test: `packages/core/test/google-discovery.test.ts`
- Test: `packages/core/test/native.test.ts`
- Test: `packages/core/test/code-mode-api.test.ts`

- [ ] **Step 1: Add failing end-to-end tool surface test**

In `packages/core/test/google-discovery.test.ts`, add:

```ts
it("executes Google Discovery operations through handleServerTool", async () => {
  const config = parseConfig({
    googleDiscoveryApis: {
      drive: {
        name: "Google Drive",
        description: "Access Google Drive files.",
        discoveryUrl: `${baseUrl}/drive.discovery.json`,
        baseUrl: `${baseUrl}/drive/v3/`,
        auth: { type: "none" },
      },
    },
  });
  const registry = new ServerRegistry(config);
  const manager = new GoogleDiscoveryManager(registry);
  const downstream = new DownstreamManager(registry);
  const caplet = config.googleDiscoveryApis.drive!;

  const list = (await handleServerTool(
    caplet,
    { operation: "tools" },
    registry,
    downstream,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    manager,
  )) as any;

  expect(list.structuredContent.result.items.map((tool: { name: string }) => tool.name)).toContain(
    "drive.files.list",
  );
});
```

The exact argument ordering must match the final `handleServerTool` signature.

- [ ] **Step 2: Run failing integration test**

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts
```

Expected: fail because engine/tools do not accept the manager.

- [ ] **Step 3: Add manager to engine**

In `packages/core/src/engine.ts`:

- import `GoogleDiscoveryManager`
- add private `googleDiscovery`
- instantiate with `{ authDir, artifactDir }`
- update registry on reload
- invalidate on backend changes
- include in `listCompletionTools`, `listTools`, and `callTool`
- include in `allCaplets`
- pass to `handleServerTool`

- [ ] **Step 4: Add manager to `tools.ts`**

In `packages/core/src/tools.ts`:

- import `GoogleDiscoveryManager`
- add optional param to `handleServerTool`
- add optional param to `backendFor`
- add branch before OpenAPI fallback:

```ts
if (server.backend === "googleDiscovery") {
  if (!googleDiscovery) {
    throw new CapletsError("INTERNAL_ERROR", "Google Discovery manager is not configured");
  }
  return {
    check: (...args: Parameters<GoogleDiscoveryManager["checkApi"]>) =>
      googleDiscovery.checkApi(...args),
    listTools: (...args: Parameters<GoogleDiscoveryManager["listTools"]>) =>
      googleDiscovery.listTools(...args),
    getTool: (...args: Parameters<GoogleDiscoveryManager["getTool"]>) =>
      googleDiscovery.getTool(...args),
    callTool: (...args: Parameters<GoogleDiscoveryManager["callTool"]>) =>
      googleDiscovery.callTool(...args),
    compact: (...args: Parameters<GoogleDiscoveryManager["compact"]>) =>
      googleDiscovery.compact(...args),
    search: (...args: Parameters<GoogleDiscoveryManager["search"]>) =>
      googleDiscovery.search(...args),
  };
}
```

- [ ] **Step 5: Add native guidance**

In `packages/core/src/native/tools.ts`, keep guidance HTTP-like:

```ts
if (caplet.backend === "googleDiscovery") {
  return [
    `${toolName} exposes Google API operations from a Google Discovery document.`,
    "Use tools/searchTools to find exact operation IDs and describeTool before calling media or write operations.",
  ];
}
```

In `packages/core/src/native/service.ts`, any direct per-backend behavior that currently checks `http`, `cli`, or `mcp` should treat `googleDiscovery` as a tool-only HTTP-like backend.

- [ ] **Step 6: Run tool/native/code-mode tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts test/native.test.ts test/code-mode-api.test.ts
```

Expected: pass.

### Task 8: OAuth Scope Inference And Auth Login Integration

**Files:**

- Modify: `packages/core/src/auth.ts`
- Modify: `packages/core/src/auth/store.ts`
- Modify: `packages/core/src/cli/auth.ts`
- Test: `packages/core/test/auth.test.ts`
- Test: `packages/core/test/google-discovery.test.ts`

- [ ] **Step 1: Add failing auth tests**

In `packages/core/test/auth.test.ts`, add a test that creates a Google Discovery config fixture and starts `auth login --no-open` with a fake manual code against a local OAuth server. Assert the printed auth URL scope includes `openid profile email` plus filtered Discovery scopes and excludes scopes from filtered-out operations.

Use the existing generic OIDC authorization-code flow tests around `runGenericOAuthFlow` as the local OAuth fixture template.

- [ ] **Step 2: Run failing auth tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/auth.test.ts test/google-discovery.test.ts
```

Expected: fail because auth target discovery does not resolve Google Discovery scopes.

- [ ] **Step 3: Add resolved-scope support to generic OAuth**

In `packages/core/src/auth.ts`, extend `GenericAuthTarget`:

```ts
resolvedScopes?: string[] | undefined;
```

Update `scopesFor`:

```ts
function scopesFor(authConfig: OAuthLikeAuthConfig, resolvedScopes?: string[]): string | undefined {
  if (authConfig.scopes?.length) return authConfig.scopes.join(" ");
  if (resolvedScopes?.length) {
    const scopes =
      authConfig.type === "oidc"
        ? ["openid", "profile", "email", ...resolvedScopes]
        : resolvedScopes;
    return [...new Set(scopes)].sort(scopeSort).join(" ");
  }
  return authConfig.type === "oidc" ? "openid profile email" : undefined;
}
```

Preserve OIDC ordering for the three identity scopes if tests depend on exact URL text; otherwise sort only API scopes and prepend identity scopes.

- [ ] **Step 4: Store requested scopes metadata**

In `writeTokenBundle` call sites inside `runGenericOAuthFlow` and `startGenericOAuthFlow.complete`, add:

```ts
metadata: redactSecrets({
  protectedResource: target.url ?? target.baseUrl ?? target.specUrl,
  authorizationServer: metadata,
  requestedScopes: scope?.split(/\s+/u).filter(Boolean),
  dynamicClient: client.dynamic ? { client_id: client.clientId } : undefined,
}) as Record<string, unknown>,
```

Do not remove existing metadata fields.

- [ ] **Step 5: Validate requested scopes on token reuse**

In `assertTokenBundleMatchesTarget`, compare required resolved scopes to `bundle.metadata.requestedScopes` when present. If metadata is absent, fall back to checking `bundle.scope` contains every required API scope. Return `AUTH_REQUIRED` if required scopes are missing.

Do not require exact equality on provider-returned `bundle.scope` because Google may canonicalize identity scopes such as `email` to `https://www.googleapis.com/auth/userinfo.email`.

- [ ] **Step 6: Resolve Google Discovery auth targets**

In `packages/core/src/cli/auth.ts`:

- include `config.googleDiscoveryApis` in `authTargets`
- for Google Discovery entries, load operations with `GoogleDiscoveryManager` and attach `resolvedScopes`
- set protected resource origin from `baseUrl` or inferred document base URL

Use a helper:

```ts
async function googleDiscoveryAuthTarget(
  api: GoogleDiscoveryApiConfig,
  authDir?: string,
): Promise<GoogleDiscoveryApiConfig & GenericAuthTarget> {
  const manager = new GoogleDiscoveryManager(
    new ServerRegistry(parseConfig({ googleDiscoveryApis: { [api.server]: api } })),
    { authDir },
  );
  return {
    ...api,
    baseUrl: await manager.resolveBaseUrl(api),
    resolvedScopes: await manager.resolveAuthScopes(api),
  };
}
```

Adapt the helper to avoid recursive config parsing if a cleaner constructor path is available.

- [ ] **Step 7: Run auth tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/auth.test.ts test/google-discovery.test.ts
```

Expected: pass.

### Task 9: Google Media Download And Upload Protocols

**Files:**

- Modify: `packages/core/src/google-discovery/request.ts`
- Modify: `packages/core/src/google-discovery/manager.ts`
- Modify: `packages/core/src/google-discovery/operations.ts`
- Test: `packages/core/test/google-discovery.test.ts`

- [ ] **Step 1: Add failing media protocol tests**

In the Google Discovery fixture server, add endpoints:

- `GET /drive/v3/files/1/download` returns `application/pdf` bytes.
- `POST /upload/drive/v3/files?uploadType=media` records raw body.
- `POST /upload/drive/v3/files?uploadType=multipart` records multipart body and returns JSON.
- `POST /upload/drive/v3/files?uploadType=resumable` returns `Location: /upload/session/abc`.
- `PUT /upload/session/abc` accepts chunks and returns final JSON after the last chunk.

Add tests:

```ts
it("writes Google media downloads as artifacts", async () => {
  const result = await manager.callTool(caplet, "drive.files.download", {
    path: { fileId: "1" },
    filename: "report.pdf",
  });
  expect(result.structuredContent).toMatchObject({
    status: 200,
    body: { artifact: { filename: "report.pdf", mimeType: "application/pdf" } },
  });
});

it("uploads media from path using multipart when metadata body is present", async () => {
  const mediaPath = join(tempDir, "report.pdf");
  writeFileSync(mediaPath, "pdf");
  const result = await manager.callTool(caplet, "drive.files.create", {
    body: { name: "report.pdf" },
    media: { path: mediaPath, mimeType: "application/pdf" },
  });
  expect(result.structuredContent).toMatchObject({ status: 200, body: { id: "uploaded" } });
  expect(lastUploadRequest.headers["content-type"]).toContain("multipart/related");
});

it("uploads small media from dataUrl and never echoes the data URL", async () => {
  const result = await manager.callTool(caplet, "drive.files.create", {
    media: { dataUrl: "data:text/plain;base64,aGVsbG8=", filename: "hello.txt" },
  });
  expect(JSON.stringify(result)).not.toContain("aGVsbG8=");
});
```

- [ ] **Step 2: Run failing media tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts
```

Expected: fail because media protocols are not implemented.

- [ ] **Step 3: Add media args to tool input schemas**

For operations with `supportsMediaUpload`, add:

```ts
media: {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    artifact: { type: "string" },
    dataUrl: { type: "string", description: "Small base64 data URL. Prefer media.path or media.artifact." },
    filename: { type: "string" },
    mimeType: { type: "string" }
  }
}
```

For `supportsMediaDownload`, add optional top-level `outputPath` and `filename` unless the implementation uses `_caplets.outputPath`; keep the final input shape documented in test assertions.

- [ ] **Step 4: Implement download path**

For `supportsMediaDownload`, call the normal request URL, fetch the response, and route through `readHttpLikeResponse` with `filename` and `outputPath`.

- [ ] **Step 5: Implement upload protocol selection**

Protocol selection:

- If `media` is absent, use normal JSON request.
- If media is present and `body` is present and `multipart` protocol exists, use multipart.
- If media is present and body is absent and simple protocol exists, use simple.
- If file size exceeds `resumableThresholdBytes` or neither simple nor multipart is available, use resumable when available.

Add defaults:

```ts
const DEFAULT_RESUMABLE_THRESHOLD_BYTES = 8 * 1024 * 1024;
const DEFAULT_RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
```

- [ ] **Step 6: Implement simple upload**

Build upload URL from `mediaUpload.protocols.simple.path` and append `uploadType=media`. Send raw bytes with content type from resolved media input.

- [ ] **Step 7: Implement multipart upload**

Build `multipart/related` body with JSON metadata part and media part:

```ts
const boundary = `caplets_${randomUUID().replace(/-/gu, "")}`;
const body = Buffer.concat([
  Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(args.body ?? {})}\r\n`,
  ),
  Buffer.from(
    `--${boundary}\r\ncontent-type: ${media.mimeType ?? "application/octet-stream"}\r\n\r\n`,
  ),
  media.bytes,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);
```

- [ ] **Step 8: Implement single-call resumable upload**

Start session with `uploadType=resumable`, `X-Upload-Content-Type`, and `X-Upload-Content-Length`. Read `Location`. Upload chunks with `Content-Range`. Retry 5xx and 429 chunk failures up to 3 attempts with short exponential backoff. Return the final JSON/media response through the shared response reader.

- [ ] **Step 9: Run media tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts test/media-artifacts.test.ts
```

Expected: pass.

### Task 10: CLI Add Command And Remote Add Shape

**Files:**

- Modify: `packages/core/src/cli/add.ts`
- Modify: `packages/core/src/cli.ts`
- Modify: `packages/core/src/remote-control/dispatch.ts` if remote add kind validation exists
- Test: `packages/core/test/cli.test.ts`
- Test: `packages/core/test/remote-control-dispatch.test.ts` if remote add kinds are tested

- [ ] **Step 1: Add failing CLI add tests**

In `packages/core/test/cli.test.ts`, add:

```ts
it("prints added Google Discovery backend Caplets", async () => {
  const out: string[] = [];
  await runCli(
    [
      "add",
      "google-discovery",
      "google-drive",
      "--discovery-url",
      "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
      "--print",
    ],
    { writeOut: (value) => out.push(value) },
  );
  expect(out.join("\n")).toContain("googleDiscoveryApi:");
  expect(out.join("\n")).toContain("discoveryUrl:");
});

it("writes Google Discovery local discovery paths that load from the original project file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caplets-add-google-discovery-path-"));
  const projectRoot = join(dir, "project");
  const cwd = process.cwd();
  try {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, "drive.discovery.json"),
      JSON.stringify({ kind: "discovery#restDescription", resources: {} }),
    );
    process.chdir(projectRoot);

    await runCli(["add", "google-discovery", "drive", "--discovery", "./drive.discovery.json"], {
      writeOut: () => {},
    });

    const config = loadConfig(
      join(dir, "user", "config.json"),
      join(projectRoot, ".caplets", "config.json"),
    );
    expect(config.googleDiscoveryApis.drive?.discoveryPath).toBe(
      join(projectRoot, "drive.discovery.json"),
    );
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing CLI tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli.test.ts
```

Expected: fail because command does not exist.

- [ ] **Step 3: Add `addGoogleDiscoveryCaplet`**

In `packages/core/src/cli/add.ts`, add options and implementation:

```ts
type AddGoogleDiscoveryOptions = AddDestinationOptions & {
  discovery?: string;
  discoveryUrl?: string;
  baseUrl?: string;
  tokenEnv?: string;
};

export function addGoogleDiscoveryCaplet(
  id: string,
  options: AddGoogleDiscoveryOptions,
): { path?: string; text: string } {
  const source = options.discovery ?? options.discoveryUrl;
  if (!source) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Google Discovery Caplet requires --discovery or --discovery-url",
    );
  }
  return writeGeneratedCaplet(
    id,
    "Google Discovery",
    "googleDiscoveryApi",
    [
      [isUrlLike(source) ? "discoveryUrl" : "discoveryPath", source],
      ["baseUrl", options.baseUrl],
      ["auth", authFromTokenEnv(options.tokenEnv) ?? { type: "none" }],
    ],
    options,
  );
}
```

- [ ] **Step 4: Add CLI command**

In `packages/core/src/cli.ts`, add:

```ts
add
  .command("google-discovery")
  .description("Add a Google Discovery API backend Caplet.")
  .argument("<id>", "Caplet ID/display seed")
  .option("--discovery <path-or-url>", "Google Discovery document path or URL")
  .option("--discovery-url <url>", "remote Google Discovery document URL")
  .option("--base-url <url>", "request base URL override")
  .option("--token-env <ENV>", "bearer token environment variable reference")
  .option("--project", "write to the project Caplets root")
  .option("-g, --global", "write to the user Caplets root")
  .option("--remote", "add through remote control")
  .option("--print", "print generated Caplet text without writing a file")
  .option("--output <path>", "output path")
  .option("--force", "overwrite an existing destination file");
```

Use kind `"googleDiscovery"` for remote add payloads.

- [ ] **Step 5: Run CLI tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli.test.ts
```

Expected: pass.

### Task 11: Docs, Schemas, And Generated References

**Files:**

- Modify: `docs/architecture.md`
- Modify: `apps/docs/src/content/docs/reference/config.mdx`
- Modify: `apps/docs/src/content/docs/reference/caplet-files.mdx`
- Modify: `apps/docs/src/content/docs/capabilities.mdx`
- Modify: `apps/docs/src/content/docs/troubleshooting.mdx`
- Modify: `apps/docs/src/content/docs/changelog.mdx`
- Generate: `schemas/caplets-config.schema.json`
- Generate: `schemas/caplet.schema.json`

- [ ] **Step 1: Generate schemas**

Run:

```bash
pnpm schema:generate
```

Expected: `schemas/caplets-config.schema.json` and `schemas/caplet.schema.json` include `googleDiscoveryApis` and `googleDiscoveryApi`.

- [ ] **Step 2: Update architecture docs**

In `docs/architecture.md`, add `googleDiscoveryApis` to supported backend families and update the HTTP-like backend section to mention Google Discovery API backends expose operation tools and share media artifact behavior.

- [ ] **Step 3: Update public docs**

In `apps/docs/src/content/docs/capabilities.mdx`, add an example:

```sh
caplets add google-discovery google-drive --discovery-url https://www.googleapis.com/discovery/v1/apis/drive/v3/rest
```

In reference docs, add tables for:

- `googleDiscoveryApis`
- `googleDiscoveryApi`
- `discoveryUrl`
- `discoveryPath`
- `baseUrl`
- `includeOperations`
- `excludeOperations`
- media upload input fields

- [ ] **Step 4: Update changelog**

Add a concise entry to `apps/docs/src/content/docs/changelog.mdx` describing:

- Google Discovery API backend
- inferred scopes
- media artifacts

- [ ] **Step 5: Run doc/schema checks**

Run:

```bash
pnpm schema:check
pnpm format:check
```

Expected: pass.

### Task 12: End-To-End Regression And Full Verification

**Files:**

- Test files touched by prior tasks
- Generated schemas and docs

- [ ] **Step 1: Run focused backend test set**

Run:

```bash
pnpm --filter @caplets/core test -- test/google-discovery.test.ts test/media-artifacts.test.ts test/http-actions.test.ts test/openapi.test.ts test/auth.test.ts test/config.test.ts test/caplet-files.test.ts test/cli.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: pass.

- [ ] **Step 3: Run generated API checks**

Run:

```bash
pnpm code-mode:check-api
pnpm schema:check
```

Expected: pass. If Code Mode declaration changes are intentional, run `pnpm code-mode:generate-api` and re-run `pnpm code-mode:check-api`.

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm verify
```

Expected: pass through `format:check`, `lint`, `code-mode:check-api`, `typecheck`, `schema:check`, `test`, `benchmark:check`, and `build`.

- [ ] **Step 5: Manual local smoke**

Use a local config with Google Drive:

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
      },
      "includeOperations": [
        "drive.files.list",
        "drive.files.get",
        "drive.files.create",
        "drive.files.download"
      ]
    }
  }
}
```

Run:

```bash
caplets auth login google-drive
caplets list-tools google-drive
caplets call-tool google-drive.drive.files.list --args '{"query":{"pageSize":5,"fields":"files(id,name,mimeType),nextPageToken"}}' --format json
```

Expected:

- auth URL includes inferred Drive scopes
- tool list includes Drive file operations
- `drive.files.list` returns HTTP `200`

## Self-Review Checklist

- Spec coverage:
  - First-class backend: Tasks 3, 4, 6, 7, 10, 11.
  - Native Discovery parser: Task 5.
  - Inferred scopes: Task 8.
  - Operation filters: Tasks 3 and 5.
  - Comprehensive media: Tasks 1, 2, 9.
  - Shared Media artifacts: Tasks 1 and 2.
  - Existing surfaces preserved: Tasks 7, 10, 11, 12.
- No third-party converter dependency is introduced.
- No persisted resumable sessions are introduced.
- Data URLs are fallback media inputs only.
- Implementation proceeds TDD-first with focused tests before `pnpm verify`.
