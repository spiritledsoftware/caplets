import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AdminCatalogMutationResult,
  AdminCatalogUpdateRequest,
  AdminCapletRecordDetail,
  AdminHostSummary,
  AdminRemoteClientPage,
  AdminV2GetCapletRecordResponse,
  AdminV2GetHostResponse,
  AdminV2ListRemoteClientsResponse,
  AdminV2PutVaultValueData,
  AdminV2PutVaultValueResponse,
  AdminV2UpdateCatalogCapletsData,
  AdminV2UpdateCatalogCapletsResponse,
  AdminVaultValue,
  AdminVaultValuePutRequest,
} from "@caplets/sdk";
import { createRootOpenApiDocument } from "../src/admin-api/openapi";
import { PROJECT_BINDING_ERROR_CODES } from "../src/project-binding/errors";
import {
  bindingTerminalReasonSchema,
  projectBindingHeartbeatRequestSchema,
  projectBindingSessionCreateRequestSchema,
  projectBindingSocketClientMessageSchema,
  projectBindingSocketServerMessageSchema,
} from "../src/project-binding/protocol";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"] as const;

interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  additionalProperties?: boolean | Record<string, unknown>;
  anyOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  maximum?: number;
}

interface OpenApiOperation {
  operationId?: string;
  deprecated?: boolean;
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name?: string;
    in?: string;
    required?: boolean;
    description?: string;
    schema?: OpenApiSchema;
  }>;
  requestBody?: {
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: OpenApiSchema }>;
      headers?: Record<string, { description?: string; schema?: OpenApiSchema }>;
    }
  >;
}

interface OpenApiDocumentView {
  openapi?: string;
  servers?: Array<{ url?: string; description?: string }>;
  paths?: Record<string, Partial<Record<(typeof HTTP_METHODS)[number], OpenApiOperation>>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<
      string,
      { type?: string; in?: string; name?: string; scheme?: string; description?: string }
    >;
  };
}

function documentView(): OpenApiDocumentView {
  return createRootOpenApiDocument() as OpenApiDocumentView;
}

function operations(document: OpenApiDocumentView) {
  const result: Array<{ path: string; method: string; operation: OpenApiOperation }> = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation) result.push({ path, method, operation });
    }
  }
  return result;
}

function operationAt(
  document: OpenApiDocumentView,
  path: string,
  method: (typeof HTTP_METHODS)[number],
) {
  const operation = document.paths?.[path]?.[method];
  expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
  return operation!;
}

function maximumOpenApiValue(
  schema: OpenApiSchema,
  components: Record<string, OpenApiSchema>,
  path: string,
): unknown {
  if (schema.$ref) {
    const prefix = "#/components/schemas/";
    if (!schema.$ref.startsWith(prefix))
      throw new Error(`${path} uses an external schema reference`);
    const name = schema.$ref.slice(prefix.length);
    const referenced = components[name];
    if (!referenced) throw new Error(`${path} references missing schema ${name}`);
    return maximumOpenApiValue(referenced, components, `${path} -> ${name}`);
  }
  const branches = schema.oneOf ?? schema.anyOf;
  if (branches) {
    const values = branches.map((branch, index) =>
      maximumOpenApiValue(branch, components, `${path}[${index}]`),
    );
    return values.reduce((largest, candidate) =>
      Buffer.byteLength(JSON.stringify(candidate), "utf8") >
      Buffer.byteLength(JSON.stringify(largest), "utf8")
        ? candidate
        : largest,
    );
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) {
    return schema.enum.reduce((largest, candidate) =>
      Buffer.byteLength(JSON.stringify(candidate), "utf8") >
      Buffer.byteLength(JSON.stringify(largest), "utf8")
        ? candidate
        : largest,
    );
  }
  if (Array.isArray(schema.type)) {
    const nonNullType = schema.type.find((candidate) => candidate !== "null");
    if (!nonNullType) return null;
    return maximumOpenApiValue({ ...schema, type: nonNullType }, components, path);
  }
  if (schema.type === "object" || schema.properties) {
    if (schema.additionalProperties !== false) {
      throw new Error(`${path} does not close its property set`);
    }
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, property]) => [
        key,
        maximumOpenApiValue(property, components, `${path}.${key}`),
      ]),
    );
  }
  if (schema.type === "array" || schema.items) {
    if (schema.maxItems === undefined) throw new Error(`${path} has no maxItems`);
    if (!schema.items) throw new Error(`${path} has no item schema`);
    const item = maximumOpenApiValue(schema.items, components, `${path}[]`);
    return Array.from({ length: schema.maxItems }, () => item);
  }
  if (schema.type === "string") {
    if (schema.maxLength === undefined) throw new Error(`${path} has no maxLength`);
    return "\ud800".repeat(schema.maxLength);
  }
  if (schema.type === "integer" || schema.type === "number") {
    return schema.maximum ?? Number.MAX_SAFE_INTEGER;
  }
  if (schema.type === "boolean") return true;
  if (schema.type === "null") return null;
  throw new Error(`${path} has no bounded materializable type`);
}

const REQUIRED_PATHS = [
  "/api",
  "/api/v1",
  "/api/v1/healthz",
  "/api/v1/remote/login/start",
  "/api/v1/remote/login/poll",
  "/api/v1/remote/login/refresh",
  "/api/v1/remote/login/complete",
  "/api/v1/remote/login/cancel",
  "/api/v1/remote/refresh",
  "/api/v1/remote/client",
  "/api/v1/attach/sessions",
  "/api/v1/attach/sessions/{sessionId}",
  "/api/v1/attach/manifest",
  "/api/v1/attach/invoke",
  "/api/v1/attach/events",
  "/api/v1/attach/project-bindings/connect",
  "/api/v1/attach/project-bindings/sessions",
  "/api/v1/attach/project-bindings/{bindingId}/status",
  "/api/v1/attach/project-bindings/{bindingId}/session",
  "/api/v1/attach/project-bindings/{bindingId}/heartbeat",
  "/api/v2/admin/host",
  "/api/v2/admin/runtime",
  "/api/v2/admin/runtime-restarts",
  "/api/v2/admin/logs",
  "/api/v2/admin/diagnostics",
  "/api/v2/admin/project-binding",
  "/api/v2/admin/events",
  "/api/v2/admin/activity",
  "/api/v2/admin/caplets",
  "/api/v2/admin/catalog/entries",
  "/api/v2/admin/catalog/entries/{entryKey}",
  "/api/v2/admin/catalog/update-candidates",
  "/api/v2/admin/catalog/installations",
  "/api/v2/admin/catalog/update-runs",
  "/api/v2/admin/remote-clients",
  "/api/v2/admin/remote-clients/{clientId}",
  "/api/v2/admin/remote-login-requests",
  "/api/v2/admin/remote-login-requests/{flowId}",
  "/api/v2/admin/backend-auth-connections",
  "/api/v2/admin/backend-auth-connections/{serverId}",
  "/api/v2/admin/backend-auth-flows",
  "/api/v2/admin/backend-auth-flows/{flowId}",
  "/api/v2/admin/backend-auth-flows/{flowId}/callback",
  "/api/v2/admin/backend-auth-refreshes",
  "/api/v2/admin/vault-values",
  "/api/v2/admin/vault-values/{storedKey}",
  "/api/v2/admin/vault-grants",
  "/api/v2/admin/vault-values/{storedKey}/grants",
  "/api/v2/admin/vault-values/{storedKey}/grants/{capletId}/{referenceName}",
  "/api/v2/admin/caplet-records",
  "/api/v2/admin/caplet-records/{id}",
  "/api/v2/admin/caplet-records/{id}/bundle",
  "/api/v2/admin/caplet-records/{id}/revisions",
  "/api/v2/admin/caplet-records/{id}/revisions/{revisionKey}",
  "/api/v2/admin/caplet-records/{id}/revisions/{revisionKey}/bundle",
  "/api/v2/admin/caplet-records/{id}/current-revision",
  "/api/v2/admin/caplet-records/{id}/installations",
  "/api/v2/admin/caplet-records/{id}/installations/{installationKey}",
  "/api/v2/admin/caplet-records/{id}/installation-observations",
] as const;

describe("canonical root OpenAPI contract", () => {
  it("generates deterministic OpenAPI 3.1 with a relative server and unique stable operation IDs", () => {
    const first = documentView();
    const second = documentView();

    expect(first.openapi).toBe("3.1.0");
    expect(first.servers).toEqual([{ url: "/" }]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const ids = operations(first).map(({ operation }) => operation.operationId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, operation } of operations(first).filter(({ path }) =>
      path.startsWith("/api/v2/admin"),
    )) {
      expect(operation.operationId, path).toMatch(/^adminV2/);
    }
  });

  it("contains the complete canonical public surface and excludes private protocol surfaces", () => {
    const document = documentView();
    const paths = Object.keys(document.paths ?? {});

    for (const path of REQUIRED_PATHS) expect(paths, path).toContain(path);
    expect(
      operationAt(document, "/api/v1/attach/project-bindings/connect", "get").responses,
    ).toHaveProperty("101");

    expect(paths.some((path) => path.includes("/mcp"))).toBe(false);
    expect(paths.some((path) => path.startsWith("/dashboard"))).toBe(false);
    expect(paths.some((path) => path.includes("/private/"))).toBe(false);
    expect(paths.some((path) => path.includes("websocket"))).toBe(false);
    expect(paths).not.toContain("/");
    expect(paths).not.toContain("/.well-known/caplets");
    expect(paths).not.toContain("/api/openapi.json");
    expect(paths.some((path) => path.startsWith("/v1"))).toBe(false);
    expect(paths.some((path) => path.startsWith("/v2"))).toBe(false);
  });

  it("publishes mounted Remote Login and Attach success and legacy error envelopes", () => {
    const document = documentView();
    const responseRef = (path: string, method: (typeof HTTP_METHODS)[number], status: string) =>
      operationAt(document, path, method).responses?.[status]?.content?.["application/json"]?.schema
        ?.$ref;

    expect(responseRef("/api/v1/remote/login/start", "post", "200")).toBe(
      "#/components/schemas/RemoteLoginStartResponse",
    );
    expect(responseRef("/api/v1/remote/login/poll", "post", "200")).toBe(
      "#/components/schemas/RemoteLoginPollResponse",
    );
    expect(responseRef("/api/v1/remote/login/refresh", "post", "200")).toBe(
      "#/components/schemas/RemoteLoginRefreshResponse",
    );
    expect(responseRef("/api/v1/remote/login/complete", "post", "200")).toBe(
      "#/components/schemas/RemoteLoginCompletionResponse",
    );
    expect(responseRef("/api/v1/remote/login/cancel", "post", "200")).toBe(
      "#/components/schemas/RemoteLoginCancelResponse",
    );
    expect(responseRef("/api/v1/remote/login/start", "post", "400")).toBe(
      "#/components/schemas/RemoteLoginErrorResponse",
    );
    expect(responseRef("/api/v1/remote/login/poll", "post", "401")).toBe(
      "#/components/schemas/RemoteLoginErrorResponse",
    );

    expect(responseRef("/api/v1/attach/sessions", "post", "201")).toBe(
      "#/components/schemas/AttachSessionCreateResponse",
    );
    expect(responseRef("/api/v1/attach/sessions/{sessionId}", "delete", "200")).toBe(
      "#/components/schemas/AttachSessionDeleteResponse",
    );
    expect(responseRef("/api/v1/attach/invoke", "post", "200")).toBe(
      "#/components/schemas/AttachInvokeResponse",
    );
    for (const status of ["400", "404", "409", "500"]) {
      expect(responseRef("/api/v1/attach/invoke", "post", status)).toBe(
        "#/components/schemas/AttachErrorResponse",
      );
    }

    const remoteStart = document.components?.schemas?.RemoteLoginStartResponse;
    expect(Object.keys(remoteStart?.properties ?? {}).sort()).toEqual([
      "approvalCommand",
      "codeExpiresAt",
      "flowExpiresAt",
      "flowId",
      "intervalSeconds",
      "operatorCode",
      "operatorCodeFingerprint",
      "pendingCompletionSecret",
      "pendingRefreshSecret",
    ]);
    expect(remoteStart?.additionalProperties).toBe(false);
    expect(document.components?.schemas?.RemoteLoginCompletionResponse?.required?.sort()).toEqual([
      "accessToken",
      "clientId",
      "clientLabel",
      "createdAt",
      "expiresAt",
      "hostUrl",
      "refreshToken",
      "role",
      "tokenType",
    ]);
    expect(document.components?.schemas?.AttachManifest?.required).toContain("codeModeCaplets");

    for (const path of [
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/refresh",
      "/api/v1/remote/login/complete",
      "/api/v1/remote/login/cancel",
      "/api/v1/attach/sessions",
      "/api/v1/attach/sessions/{sessionId}",
      "/api/v1/attach/manifest",
      "/api/v1/attach/invoke",
    ]) {
      expect(JSON.stringify(document.paths?.[path]), path).not.toContain(
        "application/problem+json",
      );
      expect(JSON.stringify(document.paths?.[path]), path).not.toContain(
        "#/components/schemas/AdminResource",
      );
    }
  });

  it("publishes the bounded Caplet installation observation page", () => {
    const document = documentView();
    const operation = operationAt(
      document,
      "/api/v2/admin/caplet-records/{id}/installation-observations",
      "get",
    );

    expect(operation.operationId).toBe("adminV2ListCapletRecordInstallationObservations");
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", in: "path" }),
        expect.objectContaining({ name: "limit", in: "query" }),
        expect.objectContaining({ name: "cursor", in: "query" }),
      ]),
    );
    expect(operation.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/AdminCapletInstallationObservationPage",
    );
    expect(
      document.components?.schemas?.AdminCapletInstallationObservationPage?.properties?.items?.items
        ?.$ref,
    ).toBe("#/components/schemas/AdminCapletInstallationObservation");
  });

  it("publishes exact Project Binding HTTP components without WebSocket payload drift", () => {
    const document = documentView();
    const requestRef = (path: string, method: (typeof HTTP_METHODS)[number]) =>
      operationAt(document, path, method).requestBody?.content?.["application/json"]?.schema?.$ref;
    const responseRef = (path: string, method: (typeof HTTP_METHODS)[number], status = "200") =>
      operationAt(document, path, method).responses?.[status]?.content?.["application/json"]?.schema
        ?.$ref;

    expect(requestRef("/api/v1/attach/project-bindings/sessions", "post")).toBe(
      "#/components/schemas/ProjectBindingSessionCreateRequest",
    );
    expect(requestRef("/api/v1/attach/project-bindings/{bindingId}/heartbeat", "post")).toBe(
      "#/components/schemas/ProjectBindingHeartbeatRequest",
    );
    expect(responseRef("/api/v1/attach/project-bindings/sessions", "post", "201")).toBe(
      "#/components/schemas/ProjectBindingSessionCreateResponse",
    );
    expect(responseRef("/api/v1/attach/project-bindings/{bindingId}/status", "get")).toBe(
      "#/components/schemas/ProjectBindingStatusResponse",
    );
    expect(responseRef("/api/v1/attach/project-bindings/{bindingId}/session", "get")).toBe(
      "#/components/schemas/ProjectBindingSessionGetResponse",
    );
    expect(responseRef("/api/v1/attach/project-bindings/{bindingId}/heartbeat", "post")).toBe(
      "#/components/schemas/ProjectBindingHeartbeatResponse",
    );
    expect(responseRef("/api/v1/attach/project-bindings/{bindingId}/session", "delete")).toBe(
      "#/components/schemas/ProjectBindingSessionDeleteResponse",
    );

    const createRequest = document.components?.schemas?.ProjectBindingSessionCreateRequest;
    expect(Object.keys(createRequest?.properties ?? {}).sort()).toEqual([
      "projectFingerprint",
      "projectRoot",
    ]);
    expect(createRequest?.required?.sort()).toEqual(["projectFingerprint", "projectRoot"]);
    expect(createRequest?.additionalProperties).toBe(false);
    const heartbeatRequest = document.components?.schemas?.ProjectBindingHeartbeatRequest;
    expect(Object.keys(heartbeatRequest?.properties ?? {}).sort()).toEqual([
      "sessionId",
      "state",
      "syncState",
    ]);
    expect(heartbeatRequest?.required?.sort()).toEqual(["sessionId", "state", "syncState"]);
    expect(heartbeatRequest?.additionalProperties).toBe(false);

    expect(document.components?.schemas).not.toHaveProperty("ProjectBindingSocketClientMessage");
    expect(document.components?.schemas).not.toHaveProperty("ProjectBindingSocketServerMessage");

    const bindingOperations = operations(document).filter(({ path }) =>
      path.startsWith("/api/v1/attach/project-bindings"),
    );
    for (const { path, method, operation } of bindingOperations) {
      expect(JSON.stringify(operation), `${method.toUpperCase()} ${path}`).not.toContain(
        "application/problem+json",
      );
      expect(JSON.stringify(operation), `${method.toUpperCase()} ${path}`).not.toContain(
        "#/components/schemas/AdminResource",
      );
      expect(JSON.stringify(operation), `${method.toUpperCase()} ${path}`).not.toContain(
        "#/components/schemas/OperationResult",
      );
    }

    const connect = operationAt(document, "/api/v1/attach/project-bindings/connect", "get");
    expect(connect.description ?? connect.responses?.["101"]?.description).toContain(
      "caplets.project-binding.v1",
    );
    expect(connect.responses?.["101"]?.description).not.toContain(
      "ProjectBindingSocketClientMessage",
    );
    expect(connect.responses?.["101"]?.description).not.toContain(
      "ProjectBindingSocketServerMessage",
    );
    const negotiatedProtocol =
      connect.responses?.["101"]?.headers?.["Sec-WebSocket-Protocol"]?.schema;
    expect(negotiatedProtocol?.const ?? negotiatedProtocol?.enum?.[0]).toBe(
      "caplets.project-binding.v1",
    );
    expect(Object.keys(connect.responses?.["426"]?.content ?? {})).toEqual(["application/json"]);
    expect(Object.keys(connect.responses?.["401"]?.content ?? {})).toEqual(["text/plain"]);
    expect(
      Object.keys(
        operationAt(document, "/api/v1/attach/project-bindings/sessions", "post").responses?.["400"]
          ?.content ?? {},
      ),
    ).toEqual(["application/json"]);
  });

  it("rejects missing, unknown, extra, and invalid Project Binding v1 fields", () => {
    expect(
      projectBindingSessionCreateRequestSchema.safeParse({
        projectRoot: "/project",
        projectFingerprint: "sha256_project",
      }).success,
    ).toBe(true);
    expect(
      projectBindingSessionCreateRequestSchema.safeParse({ projectRoot: "/project" }).success,
    ).toBe(false);
    expect(
      projectBindingSessionCreateRequestSchema.safeParse({
        projectRoot: "/project",
        projectFingerprint: "sha256_project",
        serverWorkspaceFingerprint: "ignored-before-v1",
      }).success,
    ).toBe(false);

    expect(
      projectBindingHeartbeatRequestSchema.safeParse({
        sessionId: "session_1",
        state: "ready",
        syncState: "idle",
      }).success,
    ).toBe(true);
    for (const body of [
      { sessionId: "session_1", state: "ready" },
      { sessionId: "session_1", state: "unknown", syncState: "idle" },
      { sessionId: "session_1", state: "ready", syncState: "unknown" },
      { sessionId: "session_1", state: "ready", syncState: "idle", generation: 1 },
    ]) {
      expect(projectBindingHeartbeatRequestSchema.safeParse(body).success).toBe(false);
    }

    const terminalReason = { code: "completed", message: "Complete." } as const;
    for (const code of [...PROJECT_BINDING_ERROR_CODES, "interrupted", "completed"] as const) {
      expect(bindingTerminalReasonSchema.safeParse({ code, message: "Terminal." }).success).toBe(
        true,
      );
    }
    expect(
      bindingTerminalReasonSchema.safeParse({ code: "unknown", message: "Terminal." }).success,
    ).toBe(false);
    expect(
      bindingTerminalReasonSchema.safeParse({ ...terminalReason, ignored: true }).success,
    ).toBe(false);

    expect(
      projectBindingSocketClientMessageSchema.safeParse({
        type: "heartbeat",
        bindingId: "binding_1",
        sessionId: "session_1",
        state: "ready",
        syncState: "idle",
      }).success,
    ).toBe(true);
    expect(
      projectBindingSocketClientMessageSchema.safeParse({
        type: "end",
        bindingId: "binding_1",
        sessionId: "session_1",
        reason: terminalReason,
        ignored: true,
      }).success,
    ).toBe(false);
    expect(projectBindingSocketClientMessageSchema.safeParse({ type: "unknown" }).success).toBe(
      false,
    );

    for (const message of [
      { type: "state", state: "ready", syncState: "idle" },
      {
        type: "ready",
        bindingId: "binding_1",
        sessionId: "session_1",
        syncState: "idle",
      },
      { type: "blocked", reason: terminalReason },
      { type: "ended", reason: terminalReason },
    ]) {
      expect(projectBindingSocketServerMessageSchema.safeParse(message).success).toBe(true);
    }
    expect(
      projectBindingSocketServerMessageSchema.safeParse({
        type: "ready",
        sessionId: "session_1",
        syncState: "idle",
      }).success,
    ).toBe(false);
    expect(
      projectBindingSocketServerMessageSchema.safeParse({
        type: "state",
        state: "ready",
        syncState: "unknown",
      }).success,
    ).toBe(false);
    expect(
      projectBindingSocketServerMessageSchema.safeParse({
        type: "ended",
        reason: terminalReason,
        ignored: true,
      }).success,
    ).toBe(false);
  });

  it("declares bearer and dashboard-session alternatives on canonical Admin operations", () => {
    const document = documentView();
    const callbackPath = "/api/v2/admin/backend-auth-flows/{flowId}/callback";
    const adminOperations = operations(document).filter(({ path }) =>
      path.startsWith("/api/v2/admin"),
    );

    expect(document.components?.securitySchemes?.dashboardSession).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "caplets_dashboard_session",
    });
    for (const { path, method, operation } of adminOperations) {
      expect(operation.security, `${method.toUpperCase()} ${path}`).toEqual(
        path === callbackPath ? [] : [{ bearerAuth: [] }, { dashboardSession: [] }],
      );
      const csrfParameter = operation.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "X-Caplets-CSRF",
      );
      if (method === "get") {
        expect(csrfParameter, `${method.toUpperCase()} ${path}`).toBeUndefined();
      } else {
        expect(csrfParameter, `${method.toUpperCase()} ${path}`).toMatchObject({
          required: false,
          description: expect.stringContaining("dashboard session"),
        });
      }
    }

    const callback = operationAt(document, callbackPath, "get");
    expect(callback.responses?.["200"]?.headers?.["Cache-Control"]?.schema?.enum).toEqual([
      "no-store",
    ]);
  });

  it("matches mounted public response media and direct Admin resource shapes", () => {
    const document = documentView();
    const remoteRefresh = operationAt(document, "/api/v1/remote/refresh", "post");
    const remoteClient = operationAt(document, "/api/v1/remote/client", "delete");

    expect(remoteRefresh.responses?.["401"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/RemoteLoginErrorResponse",
    );
    expect(remoteClient.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/RemoteClientDeleteResponse",
    );
    expect(Object.keys(remoteClient.responses?.["401"]?.content ?? {}).sort()).toEqual([
      "application/json",
      "text/plain",
    ]);
    expect(Object.keys(remoteClient.responses?.["403"]?.content ?? {})).toEqual(["text/plain"]);

    const projectBinding = document.components?.schemas?.AdminProjectBinding;
    expect(projectBinding?.required).toEqual(["state", "affectedCaplets", "actions"]);
    expect(projectBinding?.properties).not.toHaveProperty("projectBinding");
    expect(
      operationAt(document, "/api/v2/admin/vault-values/{storedKey}", "get").responses?.["200"]
        ?.content?.["application/json"]?.schema?.$ref,
    ).toBe("#/components/schemas/AdminVaultValue");
  });

  it("models Attach and Admin SSE data as strict named runtime objects", () => {
    const document = documentView();
    const attachEvent = operationAt(document, "/api/v1/attach/events", "get");
    const adminEvent = operationAt(document, "/api/v2/admin/events", "get");
    expect(attachEvent.responses?.["200"]?.content?.["text/event-stream"]?.schema?.$ref).toBe(
      "#/components/schemas/AttachManifestRevisionEvent",
    );
    expect(adminEvent.responses?.["200"]?.content?.["text/event-stream"]?.schema?.$ref).toBe(
      "#/components/schemas/AdminRuntimeEvent",
    );
    const schemas = document.components?.schemas as Record<string, OpenApiSchema>;
    expect(schemas.AttachManifestRevisionEvent).toMatchObject({
      type: "object",
      required: ["revision"],
      additionalProperties: false,
    });
    expect(schemas.AdminRuntimeEvent).toMatchObject({
      type: "object",
      required: ["type", "runtime", "projectBinding"],
      additionalProperties: false,
    });
    expect(schemas.AdminRuntimeEventRuntime?.oneOf).toEqual([
      expect.objectContaining({
        required: ["status", "version"],
        additionalProperties: false,
        properties: expect.objectContaining({ status: expect.objectContaining({ enum: ["ok"] }) }),
      }),
      expect.objectContaining({
        required: ["status", "version"],
        additionalProperties: false,
        properties: expect.objectContaining({
          status: expect.objectContaining({ enum: ["error"] }),
          reason: expect.any(Object),
        }),
      }),
    ]);
  });

  it("documents Problem Details, conditions, idempotency, and bundle streaming media", () => {
    const document = documentView();

    for (const { path, method, operation } of operations(document)) {
      if (
        path.startsWith("/api/v1/attach") ||
        path.startsWith("/api/v1/remote/login") ||
        path === "/api/v1/remote/refresh" ||
        path === "/api/v1/remote/client" ||
        path === "/api/v1/admin"
      ) {
        continue;
      }
      expect(
        Object.values(operation.responses ?? {}).some((response) =>
          Object.hasOwn(response.content ?? {}, "application/problem+json"),
        ),
        `${method.toUpperCase()} ${path}`,
      ).toBe(true);
    }

    const patchRecord = operationAt(document, "/api/v2/admin/caplet-records/{id}", "patch");
    expect(patchRecord.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "If-Match", in: "header" })]),
    );
    expect(Object.keys(patchRecord.requestBody?.content ?? {})).toContain(
      "application/merge-patch+json",
    );

    const restart = operationAt(document, "/api/v2/admin/runtime-restarts", "post");
    expect(restart.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Idempotency-Key", in: "header" })]),
    );
    expect(Object.keys(restart.responses ?? {})).toEqual(
      expect.arrayContaining(["201", "503", "default"]),
    );
    expect(restart.responses?.["503"]?.content?.["application/problem+json"]?.schema?.$ref).toBe(
      "#/components/schemas/Problem",
    );

    const vaultGrantDetail = operationAt(
      document,
      "/api/v2/admin/vault-values/{storedKey}/grants/{capletId}/{referenceName}",
      "get",
    );
    expect(vaultGrantDetail.operationId).toBe("adminV2GetVaultGrant");
    expect(vaultGrantDetail.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/AdminVaultGrant",
    );
    expect(vaultGrantDetail.responses?.["200"]?.headers).toHaveProperty("ETag");
    const putVaultValue = operationAt(document, "/api/v2/admin/vault-values/{storedKey}", "put");
    expect(putVaultValue.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "X-Caplets-Grant-If-Match",
          in: "header",
          required: false,
        }),
      ]),
    );
    expect(Object.keys(putVaultValue.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "201", "412", "428", "default"]),
    );
    const deleteRevision = operationAt(
      document,
      "/api/v2/admin/caplet-records/{id}/revisions/{revisionKey}",
      "delete",
    );
    expect(deleteRevision.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "If-Match", in: "header", required: true }),
        expect.objectContaining({
          name: "X-Caplets-Parent-If-Match",
          in: "header",
          required: true,
        }),
      ]),
    );
    expect(Object.keys(deleteRevision.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "412", "428", "default"]),
    );

    const putBundle = operationAt(document, "/api/v2/admin/caplet-records/{id}/bundle", "put");
    expect(putBundle.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "If-Match", in: "header" }),
        expect.objectContaining({ name: "If-None-Match", in: "header" }),
      ]),
    );
    expect(Object.keys(putBundle.requestBody?.content ?? {})).toContain("multipart/form-data");
    expect(Object.keys(putBundle.responses?.["200"]?.content ?? {})).toContain("application/json");
    for (const status of ["401", "403"] as const) {
      const response = operationAt(document, "/api/v2/admin/host", "get").responses?.[status];
      expect(Object.keys(response?.content ?? {})).toEqual(["application/problem+json"]);
      expect(response?.headers).toHaveProperty("Cache-Control");
    }
    expect(Object.keys(putBundle.responses?.["429"]?.content ?? {})).toEqual([
      "application/problem+json",
    ]);
    expect(putBundle.responses?.["429"]?.headers).toEqual(
      expect.objectContaining({
        "Cache-Control": expect.anything(),
        "Retry-After": expect.anything(),
      }),
    );

    const getBundle = operationAt(document, "/api/v2/admin/caplet-records/{id}/bundle", "get");
    const getRevisionBundle = operationAt(
      document,
      "/api/v2/admin/caplet-records/{id}/revisions/{revisionKey}/bundle",
      "get",
    );
    expect(Object.keys(getBundle.responses?.["200"]?.content ?? {})).toEqual(["multipart/mixed"]);
    expect(Object.keys(getRevisionBundle.responses?.["200"]?.content ?? {})).toEqual([
      "multipart/mixed",
    ]);
  });

  it("documents the complete bounded Operator Activity action vocabulary", () => {
    const activity = operationAt(documentView(), "/api/v2/admin/activity", "get");
    const action = activity.parameters?.find(
      (parameter) => parameter.name === "action" && parameter.in === "query",
    )?.schema;

    expect(action).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-z][a-z0-9_.-]{0,127}$",
    });
    expect(action?.enum).toBeUndefined();
  });

  it("bounds every accepted Admin mutation response below durable replay capacity", () => {
    const document = documentView();
    const mutationOperations = operations(document).filter(
      ({ path, method }) => path.startsWith("/api/v2/admin/") && method !== "get",
    );
    expect(mutationOperations.map(({ operation }) => operation.operationId).sort()).toEqual([
      "adminV2CreateCapletRecordInstallationObservation",
      "adminV2CreateRuntimeRestart",
      "adminV2DeleteBackendAuth",
      "adminV2DeleteCapletRecord",
      "adminV2DeleteCapletRecordInstallation",
      "adminV2DeleteCapletRecordRevision",
      "adminV2DeleteRemoteClient",
      "adminV2DeleteVaultValue",
      "adminV2InstallCatalogCaplets",
      "adminV2PutCapletRecordBundle",
      "adminV2PutCapletRecordCurrentRevision",
      "adminV2PutCapletRecordInstallation",
      "adminV2PutVaultGrant",
      "adminV2PutVaultValue",
      "adminV2RefreshBackendAuth",
      "adminV2RevokeVaultAccess",
      "adminV2StartBackendAuthFlow",
      "adminV2UpdateCapletRecord",
      "adminV2UpdateCatalogCaplets",
      "adminV2UpdateRemoteClient",
      "adminV2UpdateRemoteLoginRequest",
    ]);

    const components = document.components?.schemas ?? {};
    for (const { path, method, operation } of mutationOperations) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!/^2\d\d$/u.test(status)) continue;
        const schema = response.content?.["application/json"]?.schema;
        expect(schema, `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
        const maximum = maximumOpenApiValue(
          schema!,
          components,
          `${method.toUpperCase()} ${path} ${status}`,
        );
        expect(
          Buffer.byteLength(JSON.stringify(maximum), "utf8"),
          `${method.toUpperCase()} ${path} ${status}`,
        ).toBeLessThanOrEqual(1024 * 1024);
      }
    }
  });

  it("uses concrete direct response DTOs and concrete cursor items across every Admin family", () => {
    const document = documentView();
    const responseRef = (
      path: string,
      method: (typeof HTTP_METHODS)[number],
      status = "200",
      mediaType = "application/json",
    ) =>
      operationAt(document, path, method).responses?.[status]?.content?.[mediaType]?.schema?.$ref;

    expect(responseRef("/api/v2/admin/host", "get")).toBe("#/components/schemas/AdminHostSummary");
    expect(responseRef("/api/v2/admin/runtime", "get")).toBe("#/components/schemas/AdminRuntime");
    expect(responseRef("/api/v2/admin/logs", "get")).toBe("#/components/schemas/AdminLogPage");
    expect(responseRef("/api/v2/admin/diagnostics", "get")).toBe(
      "#/components/schemas/AdminDiagnostics",
    );
    expect(responseRef("/api/v2/admin/project-binding", "get")).toBe(
      "#/components/schemas/AdminProjectBinding",
    );
    expect(responseRef("/api/v2/admin/activity", "get")).toBe(
      "#/components/schemas/AdminActivityPage",
    );
    expect(responseRef("/api/v2/admin/caplets", "get")).toBe(
      "#/components/schemas/AdminEffectiveCapletPage",
    );
    expect(responseRef("/api/v2/admin/catalog/entries", "get")).toBe(
      "#/components/schemas/AdminCatalogEntryPage",
    );
    expect(responseRef("/api/v2/admin/catalog/entries/{entryKey}", "get")).toBe(
      "#/components/schemas/AdminCatalogEntryDetail",
    );
    expect(responseRef("/api/v2/admin/catalog/update-runs", "post", "201")).toBe(
      "#/components/schemas/AdminCatalogMutationResult",
    );
    expect(responseRef("/api/v2/admin/remote-clients", "get")).toBe(
      "#/components/schemas/AdminRemoteClientPage",
    );
    expect(responseRef("/api/v2/admin/remote-login-requests/{flowId}", "patch")).toBe(
      "#/components/schemas/AdminRemoteLoginRequest",
    );
    expect(responseRef("/api/v2/admin/backend-auth-connections", "get")).toBe(
      "#/components/schemas/AdminBackendAuthConnectionPage",
    );
    expect(responseRef("/api/v2/admin/backend-auth-flows/{flowId}", "get")).toBe(
      "#/components/schemas/AdminBackendAuthFlow",
    );
    expect(responseRef("/api/v2/admin/vault-values", "get")).toBe(
      "#/components/schemas/AdminVaultValuePage",
    );
    expect(responseRef("/api/v2/admin/vault-grants", "get")).toBe(
      "#/components/schemas/AdminVaultGrantPage",
    );
    expect(responseRef("/api/v2/admin/caplet-records", "get")).toBe(
      "#/components/schemas/AdminCapletRecordPage",
    );
    expect(responseRef("/api/v2/admin/caplet-records/{id}", "get")).toBe(
      "#/components/schemas/AdminCapletRecordDetail",
    );
    expect(responseRef("/api/v2/admin/caplet-records/{id}/revisions", "get")).toBe(
      "#/components/schemas/AdminCapletRevisionPage",
    );
    expect(
      responseRef("/api/v2/admin/caplet-records/{id}/installations/{installationKey}", "get"),
    ).toBe("#/components/schemas/AdminCapletInstallation");

    const recordPage = document.components?.schemas?.AdminCapletRecordPage;
    expect(recordPage?.properties?.items?.items?.$ref).toBe(
      "#/components/schemas/AdminCapletRecordSummary",
    );
    const recordSummary = document.components?.schemas?.AdminCapletRecordSummary;
    expect(Object.keys(recordSummary?.properties ?? {}).sort()).toEqual([
      "createdAt",
      "currentRevision",
      "headGeneration",
      "historyLimit",
      "id",
      "recordKey",
      "updatedAt",
    ]);
    expect(recordSummary?.properties?.currentRevision?.$ref).toBe(
      "#/components/schemas/AdminCapletRevisionSummary",
    );
    expect(recordSummary?.properties?.id?.maxLength).toBe(64);
    expect(recordSummary?.properties?.recordKey?.maxLength).toBe(64);
    expect(
      document.components?.schemas?.AdminCapletRevisionSummary?.properties?.name?.maxLength,
    ).toBe(80);
    expect(document.components?.schemas?.AdminCapletRecordDetail?.properties?.record?.$ref).toBe(
      "#/components/schemas/AdminCapletRecord",
    );
    for (const [path, method, status] of [
      ["/api/v2/admin/caplet-records/{id}", "patch", "200"],
      ["/api/v2/admin/caplet-records/{id}/bundle", "put", "200"],
      ["/api/v2/admin/caplet-records/{id}/bundle", "put", "201"],
      ["/api/v2/admin/caplet-records/{id}/current-revision", "put", "200"],
    ] as const) {
      expect(responseRef(path, method, status)).toBe(
        "#/components/schemas/AdminCapletRecordSummary",
      );
    }
    expect(
      responseRef(
        "/api/v2/admin/caplet-records/{id}/installations/{installationKey}",
        "put",
        "200",
      ),
    ).toBe("#/components/schemas/AdminCapletInstallationMutationResult");
    expect(
      responseRef(
        "/api/v2/admin/caplet-records/{id}/installations/{installationKey}",
        "put",
        "201",
      ),
    ).toBe("#/components/schemas/AdminCapletInstallationMutationResult");
    expect(
      responseRef("/api/v2/admin/caplet-records/{id}/installation-observations", "post", "201"),
    ).toBe("#/components/schemas/AdminCapletInstallationObservationMutationResult");

    const adminJson = JSON.stringify(
      Object.fromEntries(
        Object.entries(document.paths ?? {}).filter(([path]) => path.startsWith("/api/v2/admin")),
      ),
    );
    expect(adminJson).not.toContain("#/components/schemas/AdminResource");
    expect(adminJson).not.toContain("#/components/schemas/CursorPage");

    for (const pageName of [
      "AdminLogPage",
      "AdminActivityPage",
      "AdminEffectiveCapletPage",
      "AdminCatalogEntryPage",
      "AdminRemoteClientPage",
      "AdminRemoteLoginRequestPage",
      "AdminBackendAuthConnectionPage",
      "AdminVaultValuePage",
      "AdminVaultGrantPage",
      "AdminCapletRecordPage",
      "AdminCapletRevisionPage",
      "AdminCapletInstallationPage",
    ]) {
      const page = document.components?.schemas?.[pageName];
      expect(page?.required, pageName).toContain("items");
      expect(page?.properties?.items?.items?.$ref, pageName).toMatch(
        /^#\/components\/schemas\/Admin/u,
      );
      expect(page?.properties).toHaveProperty("nextCursor");
    }
  });

  it("models exact mutation bodies, mutable versions, and required response headers", () => {
    const document = documentView();
    const requestRef = (path: string, method: (typeof HTTP_METHODS)[number], mediaType: string) =>
      operationAt(document, path, method).requestBody?.content?.[mediaType]?.schema?.$ref;

    expect(requestRef("/api/v2/admin/catalog/update-runs", "post", "application/json")).toBe(
      "#/components/schemas/AdminCatalogUpdateRequest",
    );
    expect(
      requestRef(
        "/api/v2/admin/remote-login-requests/{flowId}",
        "patch",
        "application/merge-patch+json",
      ),
    ).toBe("#/components/schemas/AdminRemoteLoginRequestPatch");
    expect(requestRef("/api/v2/admin/backend-auth-flows", "post", "application/json")).toBe(
      "#/components/schemas/AdminBackendAuthFlowStartRequest",
    );
    expect(requestRef("/api/v2/admin/vault-values/{storedKey}", "put", "application/json")).toBe(
      "#/components/schemas/AdminVaultValuePutRequest",
    );
    expect(
      requestRef("/api/v2/admin/caplet-records/{id}", "patch", "application/merge-patch+json"),
    ).toBe("#/components/schemas/AdminCapletRecordPatch");
    expect(
      requestRef(
        "/api/v2/admin/caplet-records/{id}/installations/{installationKey}",
        "put",
        "application/json",
      ),
    ).toBe("#/components/schemas/AdminCapletInstallationPutRequest");
    expect(
      requestRef(
        "/api/v2/admin/caplet-records/{id}/installation-observations",
        "post",
        "application/json",
      ),
    ).toBe("#/components/schemas/AdminCapletInstallationObservationRequest");

    const schemas = document.components?.schemas;
    expect(schemas?.AdminCatalogUpdateRequest?.properties?.capletIds).toMatchObject({
      maxItems: 500,
      items: { maxLength: 128 },
    });
    expect(schemas?.AdminCatalogMutationResult?.properties?.installed?.maxItems).toBe(500);
    expect(schemas?.AdminCatalogMutationResult?.required).toEqual(
      expect.arrayContaining(["installed", "installedCount", "setupActions", "setupActionCount"]),
    );
    expect(schemas?.AdminCatalogMutationResult?.properties?.setupActions?.maxItems).toBe(6);
    expect(schemas?.AdminCapletInstallationPutRequest?.properties?.sourceIdentity?.maxLength).toBe(
      64 * 1024,
    );
    expect(schemas?.AdminCapletInstallationMutationResult?.properties).not.toHaveProperty(
      "sourceIdentity",
    );
    expect(schemas?.AdminCapletInstallationObservationRequest?.properties?.risk?.$ref).toBe(
      "#/components/schemas/AdminCapletInstallationRisk",
    );
    expect(schemas?.AdminCapletInstallationRisk?.properties?.backendFamilies).toMatchObject({
      maxItems: 64,
      items: { maxLength: 128 },
    });
    expect(schemas?.AdminCapletInstallationRisk?.properties?.authScopes).toMatchObject({
      maxItems: 64,
      items: { maxLength: 512 },
    });
    expect(
      schemas?.AdminCapletInstallationObservationMutationResult?.properties,
    ).not.toHaveProperty("risk");

    expect(document.components?.schemas?.AdminRemoteClient?.required).toContain("generation");
    expect(document.components?.schemas?.AdminRemoteLoginRequest?.required).toContain("generation");
    expect(document.components?.schemas?.AdminBackendAuthConnection?.required).toContain(
      "generation",
    );
    expect(document.components?.schemas?.AdminVaultValue?.required).toContain("generation");
    expect(document.components?.schemas?.AdminVaultGrant?.required).toContain("resourceVersion");
    expect(document.components?.schemas?.AdminCapletRecord?.required).toContain("headGeneration");
    expect(document.components?.schemas?.AdminCapletInstallation?.required).toContain("generation");

    const created = operationAt(document, "/api/v2/admin/catalog/installations", "post");
    expect(created.responses?.["201"]?.headers).toEqual(
      expect.objectContaining({
        ETag: expect.anything(),
        Location: expect.anything(),
        "Idempotency-Replayed": expect.anything(),
      }),
    );
    expect(created.responses?.default?.headers).toHaveProperty("Retry-After");

    const recordPatch = operationAt(document, "/api/v2/admin/caplet-records/{id}", "patch");
    expect(recordPatch.responses?.["200"]?.headers).toEqual(
      expect.objectContaining({
        ETag: expect.anything(),
        Location: expect.anything(),
      }),
    );

    const backendRefresh = operationAt(document, "/api/v2/admin/backend-auth-refreshes", "post");
    expect(backendRefresh.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "If-Match", in: "header" })]),
    );
    expect(backendRefresh.responses).toHaveProperty("200");
    expect(backendRefresh.responses).not.toHaveProperty("201");
    expect(backendRefresh.responses?.["200"]?.headers).toEqual(
      expect.objectContaining({
        ETag: expect.anything(),
        "Idempotency-Replayed": expect.anything(),
      }),
    );

    for (const path of [
      "/api/v2/admin/caplet-records/{id}/bundle",
      "/api/v2/admin/caplet-records/{id}/revisions/{revisionKey}/bundle",
    ]) {
      expect(operationAt(document, path, "get").responses?.["200"]?.headers).toHaveProperty(
        "Content-Disposition",
      );
    }
  });

  it("generates directly usable request and response types for callers", () => {
    expectTypeOf<AdminV2GetHostResponse>().toEqualTypeOf<AdminHostSummary>();
    expectTypeOf<AdminV2ListRemoteClientsResponse>().toEqualTypeOf<AdminRemoteClientPage>();
    expectTypeOf<AdminV2GetCapletRecordResponse>().toEqualTypeOf<AdminCapletRecordDetail>();
    expectTypeOf<
      AdminV2UpdateCatalogCapletsData["body"]
    >().toEqualTypeOf<AdminCatalogUpdateRequest>();
    expectTypeOf<AdminV2UpdateCatalogCapletsResponse>().toEqualTypeOf<AdminCatalogMutationResult>();
    expectTypeOf<AdminV2PutVaultValueData["body"]>().toEqualTypeOf<AdminVaultValuePutRequest>();
    expectTypeOf<AdminV2PutVaultValueResponse>().toEqualTypeOf<AdminVaultValue>();
    expectTypeOf<AdminV2PutVaultValueData["headers"]>().toMatchTypeOf<{
      "Idempotency-Key": string;
      "If-Match"?: string;
      "If-None-Match"?: "*";
    }>();
  });

  it("does not publish dashboard-only settings and keeps the callback outside shared resources", () => {
    const document = documentView();
    const paths = Object.keys(document.paths ?? {});

    expect(paths).not.toContain("/api/v2/admin/settings");
    expect(paths).not.toContain("/dashboard/api/v2");
    expect(paths).not.toContain("/v2");
    expect(
      operationAt(document, "/api/v2/admin/backend-auth-flows/{flowId}/callback", "get").security,
    ).toEqual([]);
  });
});
