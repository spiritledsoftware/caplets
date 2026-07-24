import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { z } from "zod";

import type {
  CurrentHostOperation,
  CurrentHostOperations,
  CurrentHostPrincipal,
  CurrentHostOperatorPrincipal,
} from "../current-host/operations";
import { readLimitedJsonObject } from "../serve/request-body";
import { CapletsError, toSafeError, type SafeErrorSummary } from "../errors";
import type { ReopenableBundleFileSource } from "../storage/bundle-source";
import type { CapletRecordSummaryView } from "../storage/caplet-records";
import { MAX_IDEMPOTENCY_FINAL_BODY_BYTES } from "../storage/idempotency";
import {
  checkCreationPrecondition,
  checkMutationPrecondition,
  createStrongEtag,
} from "./conditional";
import { createBundleMultipartMetadata, createBundleMultipartStream } from "./bundle-export";
import type { AdminBundleUploadAdmissionController } from "./bundle-upload-admission";
import { parseAdminBundleUpload, type ParsedAdminBundleUpload } from "./bundle-upload-parser";
import {
  executeWithIdempotency,
  type IdempotencyExecutionOutcome,
  type IdempotencyExecutionStore,
} from "./idempotency";
import {
  ADMIN_CATALOG_MUTATION_MAX_CAPLETS,
  ADMIN_V2_ROUTE_DEFINITIONS,
  adminV2RequestHeadersForDefinition,
  type AdminV2RouteDefinition,
} from "./openapi";
import { createCursorCodec, type CursorJsonValue } from "./pagination";
import { problemResponse } from "./problem";

const JSON_MEDIA = "application/json";
const PROBLEM_MEDIA = "application/problem+json";
const NO_STORE = "no-store";
const UPLOAD_CAPACITY_RETRY_AFTER_SECONDS = 1;
const DEFAULT_PAGE_LIMIT = 100;
const ADMIN_JSON_BODY_MAX_BYTES = 1024 * 1024;

const activityPageKeySchema = z.object({
  createdAt: z.string().datetime(),
  activityKey: z.string().min(1),
});
const logPageKeySchema = z.object({
  timestamp: z.string().datetime(),
  logKey: z.string().min(1),
});
const capletPageKeySchema = z.object({ id: z.string().min(1) });
const catalogEntryPageKeySchema = z.object({ entryKey: z.string().min(1) });
const catalogUpdatePageKeySchema = z.object({ id: z.string().min(1) });
const capletRecordPageKeySchema = z.object({
  updatedAt: z.string().datetime(),
  recordKey: z.string().min(1),
});
const capletRevisionPageKeySchema = z.object({
  createdAt: z.string().datetime(),
  revisionKey: z.string().min(1),
});
const capletInstallationPageKeySchema = z.object({
  updatedAt: z.string().datetime(),
  installationKey: z.string().min(1),
});
const capletInstallationObservationPageKeySchema = z.object({
  observedAt: z.string().datetime(),
  observationKey: z.string().min(1),
});
const remoteClientPageKeySchema = z.object({
  createdAt: z.string().datetime(),
  clientId: z.string().min(1),
});
const pendingLoginPageKeySchema = z.object({
  createdAt: z.string().datetime(),
  flowId: z.string().min(1),
});
const backendConnectionPageKeySchema = z.object({
  server: z.string().min(1),
});
const vaultValuePageKeySchema = z.object({ vaultKey: z.string().min(1) });
const vaultGrantPageKeySchema = z.object({
  subjectKind: z.enum(["file", "record"]),
  subjectKey: z.string().min(1),
  referenceName: z.string().min(1),
});

export type AdminV2RequestAuthority = {
  principal: CurrentHostOperatorPrincipal;
  finalizeMutation?: (input: {
    operationId: string;
    outcome: Readonly<SemanticOutcome>;
  }) => Headers | undefined | Promise<Headers | undefined>;
};

export type AdminV2AuthorityProvider = (
  request: Request,
  context: { readonly mutates: boolean },
) => AdminV2RequestAuthority | Promise<AdminV2RequestAuthority>;

export class AdminV2PrincipalError extends CapletsError {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(status === 401 ? "AUTH_REQUIRED" : "AUTH_FAILED", message);
    this.name = "AdminV2PrincipalError";
    this.status = status;
  }
}

export type AdminV2HostContext = {
  baseUrl: string;
  dashboardUrl: string;
  dashboardPath: string;
  bind: string;
  publicOrigin?: string | null | undefined;
};

export type CreateAdminV2RouterOptions = {
  operations: CurrentHostOperations;
  authorityProvider: AdminV2AuthorityProvider;
  host: AdminV2HostContext;
  idempotencyStore?: IdempotencyExecutionStore | undefined;
  bundleUploadAdmission?: AdminBundleUploadAdmissionController | undefined;
  reportBundleUploadCleanupError?: (error: SafeErrorSummary) => void;
};

type ValidatedRouteRequest = {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body?: Record<string, unknown> | undefined;
  mediaType?: string | undefined;
  bundleUpload?: ParsedAdminBundleUpload | undefined;
  creating?: boolean | undefined;
  expectedResourceVersion?: string | undefined;
  expectedGrantResourceVersion?: string | undefined;
  creatingGrant?: boolean | undefined;
};

export type SemanticOutcome = { kind: string } & Record<string, unknown>;
type CatalogMutationIndexingStatus =
  | "accepted"
  | "already_current"
  | "counted"
  | "ineligible"
  | "rate_limited"
  | "rejected"
  | "revision_unavailable"
  | "suppressed"
  | "unavailable";
type CatalogMutationInstalledSummary = {
  kind: "file" | "directory";
  status?: "installed" | "restored" | "updated" | "content_updated" | "noop";
  catalogIndexing?: { status: CatalogMutationIndexingStatus };
};
type CatalogMutationSetupActionSummary = {
  kind:
    | "auth"
    | "vault"
    | "project_binding"
    | "backend_check"
    | "exposure_validation"
    | "code_mode";
  required: boolean;
};
type CatalogMutationSummary = {
  installed: CatalogMutationInstalledSummary[];
  installedCount: number;
  setupActions: CatalogMutationSetupActionSummary[];
  setupActionCount: number;
};

/**
 * Creates the shared relative Admin v2 router. Composition adapters mount the returned
 * router beneath their own authenticated base path.
 */
export function createAdminV2Router(options: CreateAdminV2RouterOptions): Hono {
  const app = new Hono();

  for (const rawDefinition of ADMIN_V2_ROUTE_DEFINITIONS) {
    const definition: AdminV2RouteDefinition = rawDefinition;
    // The callback has its own provider-neutral authority ceremony and is composed separately.
    if (definition.operationId === "adminV2CompleteBackendAuthFlowCallback") continue;
    // Settings is a dashboard view composed from canonical resources, not an Admin resource.
    if (
      definition.operationId === "adminV2GetSettings" ||
      definition.operationId === "adminV2UpdateSettings"
    ) {
      continue;
    }
    const path = definition.relativePath.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, ":$1");
    app.on(definition.method.toUpperCase(), path, async (context) => {
      try {
        if (definition.method !== "get") {
          return await handleMutation(context, definition, options);
        }
        const { principal } = await options.authorityProvider(context.req.raw, {
          mutates: false,
        });
        const validated = validateSafeRequest(context, definition);
        if (definition.streaming) {
          if (context.req.method === "HEAD") {
            return await handleStreamingHead(definition, validated, principal, options.operations);
          }
          return await handleStreamingGet(
            context,
            definition,
            validated,
            principal,
            options.operations,
          );
        }
        const operation = operationForSafeRoute(definition, validated, options.host);
        const outcome = await executeOperation(options.operations, principal, operation);
        const body = responseBodyForOutcome(definition, outcome, validated);
        const headers: Record<string, string> = {};
        if (definition.etag) {
          headers.ETag = etagForRepresentation(definition, body, validated);
        }
        return jsonResponse(body, headers);
      } catch (error) {
        return noStoreProblemResponse(error);
      }
    });
  }

  return app;
}

async function handleStreamingHead(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  principal: CurrentHostPrincipal,
  operations: CurrentHostOperations,
): Promise<Response> {
  if (definition.streaming === "sse") {
    return new Response(null, { status: 200, headers: adminSseHeaders() });
  }
  if (definition.streaming === "bundle-download") {
    const outcome = await executeOperation(operations, principal, bundleGetOperation(request));
    const sources = requiredBundleSources(outcome);
    const multipart = createBundleMultipartMetadata(sources);
    return new Response(null, {
      status: 200,
      headers: bundleDownloadResponseHeaders(definition, request, outcome, multipart.contentType),
    });
  }
  throw streamingUnavailableError(definition);
}

async function handleStreamingGet(
  _context: Context,
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  principal: CurrentHostPrincipal,
  operations: CurrentHostOperations,
): Promise<Response> {
  if (definition.streaming === "bundle-download") {
    const outcome = await executeOperation(operations, principal, bundleGetOperation(request));
    const sources = requiredBundleSources(outcome);
    const multipart = createBundleMultipartStream(sources);
    return new Response(multipart.body, {
      status: 200,
      headers: bundleDownloadResponseHeaders(definition, request, outcome, multipart.contentType),
    });
  }

  if (definition.streaming === "sse") {
    const events = operations.runtimeEvents(principal);
    const reader = events.getReader();
    const encoder = new TextEncoder();
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) return;
        try {
          const next = await reader.read();
          if (next.done) {
            closed = true;
            controller.close();
            return;
          }
          controller.enqueue(
            encoder.encode(`event: runtime\ndata: ${JSON.stringify(next.value)}\n\n`),
          );
        } catch (error) {
          closed = true;
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (closed) return;
        closed = true;
        await reader.cancel(reason);
      },
    });
    return new Response(body, { status: 200, headers: adminSseHeaders() });
  }

  throw streamingUnavailableError(definition);
}

function bundleGetOperation(request: ValidatedRouteRequest): CurrentHostOperation {
  return {
    kind: "stored_caplet_bundle_get",
    id: request.params.id!,
    ...(request.params.revisionKey ? { revisionKey: request.params.revisionKey } : {}),
  };
}

function requiredBundleSources(outcome: SemanticOutcome): ReopenableBundleFileSource[] {
  const sources = outcome.sources as ReopenableBundleFileSource[] | undefined;
  if (sources) return sources;
  throw new CapletsError(
    "INTERNAL_ERROR",
    "The Caplet Bundle operation did not return streaming sources.",
  );
}

function bundleDownloadResponseHeaders(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  outcome: SemanticOutcome,
  contentType: string,
): Record<string, string> {
  const id = request.params.id ?? "caplet";
  const revisionSuffix = request.params.revisionKey ? `-${request.params.revisionKey}` : "";
  const filename = `${sanitizeAttachmentToken(id)}${
    revisionSuffix ? sanitizeAttachmentToken(revisionSuffix) : ""
  }.bundle`;
  return {
    "Cache-Control": NO_STORE,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Type": contentType,
    ETag: etagForRepresentation(definition, outcome.record ?? { id }, request),
  };
}

function adminSseHeaders(): Record<string, string> {
  return { "Cache-Control": NO_STORE, "Content-Type": "text/event-stream" };
}

function streamingUnavailableError(definition: AdminV2RouteDefinition): CapletsError {
  return new CapletsError(
    "SERVER_UNAVAILABLE",
    `The ${definition.operationKinds.join("/")} streaming operation is unavailable.`,
  );
}

function sanitizeAttachmentToken(value: string): string {
  const sanitized = value.normalize("NFKC").replaceAll(/[^A-Za-z0-9._-]+/gu, "-");
  return sanitized.slice(0, 96) || "caplet";
}

async function handleMutation(
  context: Context,
  definition: AdminV2RouteDefinition,
  options: CreateAdminV2RouterOptions,
): Promise<Response> {
  const authority = await options.authorityProvider(context.req.raw, { mutates: true });
  const { principal } = authority;
  const idempotencyKey = context.req.header("Idempotency-Key");
  if (!idempotencyKey || !/^[\x21-\x7e]{1,128}$/u.test(idempotencyKey)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "A valid Idempotency-Key header is required for Admin mutations.",
    );
  }
  if (!options.idempotencyStore) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "The durable Admin idempotency store is unavailable.",
    );
  }
  const validated =
    definition.streaming === "bundle-upload"
      ? await validateBundleUploadRequest(context, definition, options)
      : await validateMutationRequest(context, definition);
  const relativeCurrentResourcePath = materializeRelativePath(
    definition.relativePath,
    validated.params,
  );
  const currentResourcePath = mountRelativeResourcePath(
    context.req.url,
    relativeCurrentResourcePath,
    relativeCurrentResourcePath,
  );
  const relativeRenamedResourcePath =
    definition.operationId === "adminV2UpdateCapletRecord" && typeof validated.body?.id === "string"
      ? materializeRelativePath(definition.relativePath, {
          ...validated.params,
          id: validated.body.id,
        })
      : undefined;
  const renamedResourcePath =
    relativeRenamedResourcePath === undefined
      ? undefined
      : mountRelativeResourcePath(
          context.req.url,
          relativeCurrentResourcePath,
          relativeRenamedResourcePath,
        );
  const reconciliationLinks = reconciliationRelativePaths(
    definition,
    validated,
    relativeCurrentResourcePath,
    relativeRenamedResourcePath,
  ).map((relativePath) =>
    mountRelativeResourcePath(context.req.url, relativeCurrentResourcePath, relativePath),
  );
  let execution: IdempotencyExecutionOutcome;
  let committedOutcome: SemanticOutcome | undefined;
  let durableResponseFinalized = false;
  let bundleUploadCleanupError: unknown;
  try {
    execution = await executeWithIdempotency({
      store: options.idempotencyStore,
      principalClientId: principal.clientId,
      operationId: definition.operationId,
      idempotencyKey,
      validatedRequest: {
        method: definition.method.toUpperCase(),
        path: validated.params,
        query: validated.query,
        mediaType: validated.mediaType ?? null,
        body: validated.body ?? null,
        validators: {
          ifMatch: context.req.header("If-Match")?.trim() ?? null,
          ifNoneMatch: context.req.header("If-None-Match")?.trim() ?? null,
          ...(definition.operationId === "adminV2PutVaultValue"
            ? {
                grantIfMatch: context.req.header("X-Caplets-Grant-If-Match")?.trim() ?? null,
              }
            : {}),
          ...(definition.operationId === "adminV2DeleteCapletRecordRevision"
            ? {
                parentIfMatch: context.req.header("X-Caplets-Parent-If-Match")?.trim() ?? null,
              }
            : {}),
        },
      },
      reconciliationLinks,
      execute: async () => {
        try {
          const expectedGeneration = await validateCurrentPrecondition(
            definition,
            validated,
            context.req.raw,
            principal,
            options.operations,
          );
          validated.expectedGrantResourceVersion = await validateVaultGrantPrecondition(
            definition,
            validated,
            context.req.raw,
            principal,
            options.operations,
          );
          const operation = operationForMutation(definition, validated, expectedGeneration);
          const outcome = await executeOperation(options.operations, principal, operation);
          const body = responseBodyForOutcome(definition, outcome, validated);
          const serializedBody = JSON.stringify(body);
          if (Buffer.byteLength(serializedBody, "utf8") > MAX_IDEMPOTENCY_FINAL_BODY_BYTES) {
            throw new CapletsError(
              "INTERNAL_ERROR",
              "The Admin mutation result exceeds durable replay capacity.",
            );
          }
          committedOutcome = outcome;
          return {
            status: validated.creating || definition.created ? 201 : 200,
            contentType: JSON_MEDIA,
            body: serializedBody,
          };
        } catch (error) {
          const storageCasLost =
            error instanceof CapletsError &&
            error.code === "REQUEST_INVALID" &&
            error.details !== null &&
            typeof error.details === "object" &&
            "kind" in error.details &&
            error.details.kind === "stale_generation";
          const createOnlyConflict =
            (validated.creating === true || validated.creatingGrant === true) &&
            error instanceof CapletsError &&
            error.code === "CONFIG_EXISTS";
          const response = noStoreProblemResponse(
            storageCasLost
              ? new CapletsError(
                  "PRECONDITION_FAILED",
                  "The resource changed before the mutation committed.",
                )
              : createOnlyConflict
                ? new CapletsError(
                    "PRECONDITION_FAILED",
                    "The resource was created before this create-only mutation committed.",
                  )
                : error,
          );
          return {
            status: response.status,
            contentType: PROBLEM_MEDIA,
            body: await response.text(),
          };
        }
      },
    });
    durableResponseFinalized = execution.outcome === "response";
  } finally {
    try {
      await validated.bundleUpload?.cleanup();
    } catch (error) {
      if (!durableResponseFinalized) bundleUploadCleanupError = error;
      else reportBundleUploadCleanupError(error, options.reportBundleUploadCleanupError);
    }
  }
  if (bundleUploadCleanupError !== undefined) throw bundleUploadCleanupError;

  const mutationResponseHeaders =
    committedOutcome === undefined || authority.finalizeMutation === undefined
      ? undefined
      : await authority.finalizeMutation({
          operationId: definition.operationId,
          outcome: committedOutcome,
        });

  switch (execution.outcome) {
    case "response": {
      const headers = new Headers({
        "Cache-Control": NO_STORE,
        "Content-Type": execution.response.contentType,
      });
      if (mutationResponseHeaders !== undefined) {
        for (const [name, value] of mutationResponseHeaders.entries()) {
          if (name.toLowerCase() !== "set-cookie") headers.append(name, value);
        }
        for (const value of mutationResponseHeaders.getSetCookie()) {
          headers.append("Set-Cookie", value);
        }
      }
      if (execution.response.status >= 200 && execution.response.status < 300) {
        const body = JSON.parse(execution.response.body) as unknown;
        if (definition.etag || definition.conditional || definition.upsert || definition.created) {
          headers.set("ETag", etagForRepresentation(definition, body, validated));
        }
        const location = mutationLocation(
          definition,
          validated,
          body,
          context.req.url,
          relativeCurrentResourcePath,
          currentResourcePath,
          renamedResourcePath,
        );
        if (location !== undefined) headers.set("Location", location);
      }
      if (execution.replayed) headers.set("Idempotency-Replayed", "true");
      return new Response(execution.response.body, {
        status: execution.response.status,
        headers,
      });
    }
    case "conflict":
      return noStoreProblemResponse(
        new CapletsError(
          "IDEMPOTENCY_CONFLICT",
          "The Idempotency-Key was already used for a different request.",
        ),
      );
    case "in_progress": {
      const response = noStoreProblemResponse(
        new CapletsError(
          "IDEMPOTENCY_IN_PROGRESS",
          "The operation for this Idempotency-Key is still in progress.",
        ),
      );
      response.headers.set("Retry-After", String(execution.retryAfterSeconds));
      return response;
    }
    case "unknown":
    case "ownership_lost": {
      const links = Object.fromEntries(
        execution.reconciliationLinks.map((href, index) => [`reconcile${index + 1}`, href]),
      );
      const response = problemResponse(
        new CapletsError(
          "IDEMPOTENCY_UNKNOWN",
          "The operation outcome is unknown and must be reconciled before retrying.",
        ),
        { links },
      );
      response.headers.set("Cache-Control", NO_STORE);
      return response;
    }
    case "capacity_exceeded":
      return noStoreProblemResponse(
        new CapletsError(
          "SERVER_UNAVAILABLE",
          "The Admin idempotency store has reached its safe capacity.",
        ),
      );
  }
}

async function validateMutationRequest(
  context: Context,
  definition: AdminV2RouteDefinition,
): Promise<ValidatedRouteRequest> {
  const validated = validateSafeRequest(context, definition);
  validateMutationPreconditionHeaders(context, definition);
  validateRouteHeaders(context, definition);

  if (!definition.body) return validated;
  const mediaType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  const content = definition.body.content as Record<string, { schema: z.ZodType }>;
  const bodyContract = mediaType ? content[mediaType] : undefined;
  if (!mediaType || !bodyContract) {
    throw new CapletsError(
      "UNSUPPORTED_MEDIA_TYPE",
      "The Admin mutation Content-Type is unsupported.",
    );
  }
  const rawBody = await readLimitedJsonObject(
    context.req.raw,
    `${definition.operationId} request`,
    ADMIN_JSON_BODY_MAX_BYTES,
  );
  const bodyResult = bodyContract.schema.safeParse(rawBody);
  if (!bodyResult.success) {
    throw new CapletsError("REQUEST_INVALID", "The Admin mutation body is invalid.");
  }
  return {
    ...validated,
    body: bodyResult.data as Record<string, unknown>,
    mediaType,
    creating: context.req.header("If-None-Match") === "*",
  };
}
async function validateBundleUploadRequest(
  context: Context,
  definition: AdminV2RouteDefinition,
  options: CreateAdminV2RouterOptions,
): Promise<ValidatedRouteRequest> {
  const validated = validateSafeRequest(context, definition);
  validateMutationPreconditionHeaders(context, definition);
  validateRouteHeaders(context, definition);
  if (!options.bundleUploadAdmission) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Caplet Bundle upload admission is unavailable.");
  }
  if (!context.req.raw.body) {
    throw new CapletsError("REQUEST_INVALID", "The Caplet Bundle upload body is required.");
  }
  const parsed = await parseAdminBundleUpload({
    input: requestBodyReadable(context.req.raw.body),
    contentType: context.req.header("Content-Type"),
    contentLength: context.req.header("Content-Length"),
    admission: options.bundleUploadAdmission,
    signal: context.req.raw.signal,
  });
  return {
    ...validated,
    body: parsed.manifest as unknown as Record<string, unknown>,
    mediaType: "multipart/form-data",
    bundleUpload: parsed,
    creating: context.req.header("If-None-Match") === "*",
  };
}

function requestBodyReadable(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  const input = Readable.from(requestBodyChunks(reader), {
    highWaterMark: 64 * 1024,
    objectMode: false,
  });
  const destroy = input.destroy.bind(input);
  let cancelStarted = false;
  input.destroy = (error?: Error) => {
    if (!input.destroyed && !input.readableEnded && !cancelStarted) {
      cancelStarted = true;
      void reader.cancel(error).catch(() => undefined);
    }
    return destroy(error);
  };
  return input;
}

async function* requestBodyChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Buffer> {
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
}

function validateRouteHeaders(context: Context, definition: AdminV2RouteDefinition): void {
  const schema = adminV2RequestHeadersForDefinition(definition);
  if (!schema) return;
  const headers = Object.fromEntries(
    Object.keys(schema.shape).flatMap((name) => {
      const value = context.req.header(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  if (!schema.safeParse(headers).success) {
    throw new CapletsError("REQUEST_INVALID", "The Admin request headers are invalid.");
  }
}

function validateMutationPreconditionHeaders(
  context: Context,
  definition: AdminV2RouteDefinition,
): void {
  const ifMatch = context.req.header("If-Match");
  const ifNoneMatch = context.req.header("If-None-Match");
  if (
    (definition.conditional ||
      definition.operationId === "adminV2CreateCapletRecordInstallationObservation") &&
    !ifMatch
  ) {
    throw new CapletsError(
      "PRECONDITION_REQUIRED",
      "An If-Match header with the current strong ETag is required.",
    );
  }
  if (
    definition.operationId === "adminV2DeleteCapletRecordRevision" &&
    !context.req.header("X-Caplets-Parent-If-Match")
  ) {
    throw new CapletsError(
      "PRECONDITION_REQUIRED",
      "An X-Caplets-Parent-If-Match header with the current parent ETag is required.",
    );
  }
  if (
    definition.created &&
    definition.operationId !== "adminV2CreateCapletRecordInstallationObservation"
  ) {
    const result = checkCreationPrecondition(ifNoneMatch);
    if (!result.ok) {
      throw new CapletsError(
        result.code,
        result.status === 428
          ? "An If-None-Match: * header is required."
          : "The creation precondition did not match.",
      );
    }
  }
  if (!definition.upsert) return;
  if (ifMatch && ifNoneMatch) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Use either If-Match or If-None-Match for an upsert, not both.",
    );
  }
  if (!ifMatch && !ifNoneMatch) {
    throw new CapletsError(
      "PRECONDITION_REQUIRED",
      "An If-Match or If-None-Match: * header is required.",
    );
  }
  if (ifNoneMatch) {
    const result = checkCreationPrecondition(ifNoneMatch);
    if (!result.ok) {
      throw new CapletsError(result.code, "The creation precondition did not match.");
    }
  }
}

async function validateCurrentPrecondition(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  rawRequest: Request,
  principal: CurrentHostPrincipal,
  operations: CurrentHostOperations,
): Promise<number | undefined> {
  if (
    !definition.conditional &&
    !definition.upsert &&
    definition.operationId !== "adminV2CreateCapletRecordInstallationObservation"
  ) {
    return undefined;
  }
  if (definition.upsert && rawRequest.headers.get("If-None-Match") === "*") {
    return undefined;
  }

  const currentOperation = currentOperationForMutation(definition, request);
  const currentOutcome = await executeOperation(operations, principal, currentOperation);
  const detailDefinition = detailDefinitionForMutation(definition);
  const currentBody = responseBodyForOutcome(detailDefinition, currentOutcome, request);
  const currentEtag = etagForRepresentation(detailDefinition, currentBody, request);
  const result = checkMutationPrecondition(rawRequest.headers.get("If-Match"), currentEtag);
  if (!result.ok) {
    throw new CapletsError(
      result.code,
      result.status === 428
        ? "An If-Match header with the current strong ETag is required."
        : "The If-Match validator is stale.",
    );
  }
  if (definition.operationId === "adminV2DeleteCapletRecordRevision") {
    const parentOutcome = await executeOperation(operations, principal, {
      kind: "stored_caplet_get",
      id: request.params.id!,
    });
    const parentDefinition = ADMIN_V2_ROUTE_DEFINITIONS.find(
      (candidate) => candidate.operationId === "adminV2GetCapletRecord",
    );
    if (!parentDefinition) {
      throw new CapletsError("INTERNAL_ERROR", "The Caplet Record detail route is missing.");
    }
    const parentBody = responseBodyForOutcome(parentDefinition, parentOutcome, request);
    const parentGeneration = generationFromOutcome(parentBody);
    const parentEtag = etagForRepresentation(parentDefinition, parentBody, request);
    const parentResult = checkMutationPrecondition(
      rawRequest.headers.get("X-Caplets-Parent-If-Match"),
      parentEtag,
    );
    if (!parentResult.ok) {
      throw new CapletsError(
        parentResult.code,
        parentResult.status === 428
          ? "An X-Caplets-Parent-If-Match header with the current parent ETag is required."
          : "The parent Caplet Record validator is stale.",
      );
    }
    if (parentGeneration === undefined) {
      throw new CapletsError("INTERNAL_ERROR", "The Caplet Record generation is unavailable.");
    }
    return parentGeneration;
  }
  request.expectedResourceVersion = resourceVersionFromOutcome(currentBody);
  return generationFromOutcome(currentBody);
}

async function validateVaultGrantPrecondition(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  rawRequest: Request,
  principal: CurrentHostPrincipal,
  operations: CurrentHostOperations,
): Promise<string | undefined> {
  if (
    definition.operationId !== "adminV2PutVaultValue" ||
    typeof request.body?.grant !== "string"
  ) {
    return undefined;
  }
  const storedKey = request.params.storedKey!;
  const capletId = request.body.grant;
  const referenceName =
    typeof request.body.referenceName === "string" ? request.body.referenceName : storedKey;
  const detailDefinition = ADMIN_V2_ROUTE_DEFINITIONS.find(
    (candidate) => candidate.operationId === "adminV2GetVaultGrant",
  );
  if (!detailDefinition) {
    throw new CapletsError("INTERNAL_ERROR", "The Vault grant detail route is missing.");
  }
  const detailRequest: ValidatedRouteRequest = {
    params: { storedKey, capletId, referenceName },
    query: {},
  };
  const outcome = await executeOperation(operations, principal, {
    kind: "vault_access_list",
    storedKey,
    capletId,
    referenceName,
  });
  let currentGrant: unknown;
  try {
    currentGrant = responseBodyForOutcome(detailDefinition, outcome, detailRequest);
  } catch (error) {
    if (!(error instanceof CapletsError) || error.code !== "SERVER_NOT_FOUND") throw error;
  }
  const grantIfMatch = rawRequest.headers.get("X-Caplets-Grant-If-Match");
  if (currentGrant === undefined) {
    if (grantIfMatch !== null) {
      throw new CapletsError("PRECONDITION_FAILED", "The conditional Vault grant does not exist.");
    }
    request.creatingGrant = true;
    return undefined;
  }
  const currentEtag = etagForRepresentation(detailDefinition, currentGrant, detailRequest);
  const result = checkMutationPrecondition(grantIfMatch, currentEtag);
  if (!result.ok) {
    throw new CapletsError(
      result.code,
      result.status === 428
        ? "X-Caplets-Grant-If-Match is required for an existing Vault grant."
        : "The Vault grant condition is stale.",
    );
  }
  const resourceVersion = resourceVersionFromOutcome(currentGrant);
  if (resourceVersion === undefined) {
    throw new CapletsError("INTERNAL_ERROR", "The Vault grant resource version is unavailable.");
  }
  return resourceVersion;
}

function currentOperationForMutation(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
): CurrentHostOperation {
  switch (definition.operationId) {
    case "adminV2UpdateRemoteClient":
    case "adminV2DeleteRemoteClient":
      return { kind: "remote_client_get", clientId: request.params.clientId! };
    case "adminV2UpdateRemoteLoginRequest":
      return { kind: "remote_login_request_get", flowId: request.params.flowId! };
    case "adminV2DeleteVaultValue":
      return { kind: "vault_get", name: request.params.storedKey! };
    case "adminV2PutVaultGrant":
    case "adminV2RevokeVaultAccess":
      return {
        kind: "vault_access_list",
        storedKey: request.params.storedKey!,
        capletId: request.params.capletId!,
        referenceName: request.params.referenceName!,
      };
    case "adminV2DeleteBackendAuth":
      return { kind: "backend_auth_connection_get", server: request.params.serverId! };
    case "adminV2RefreshBackendAuth":
      if (typeof request.body?.serverId !== "string") {
        throw new CapletsError("REQUEST_INVALID", "A backend server ID is required.");
      }
      return { kind: "backend_auth_connection_get", server: request.body.serverId };
    case "adminV2PutCapletRecordInstallation":
    case "adminV2DeleteCapletRecordInstallation":
      return {
        kind: "stored_caplet_installation_get",
        id: request.params.id!,
        installationKey: request.params.installationKey!,
      };
    case "adminV2CreateCapletRecordInstallationObservation":
      return { kind: "stored_caplet_installation_get", id: request.params.id! };
    case "adminV2PutVaultValue":
      return { kind: "vault_get", name: request.params.storedKey! };
    case "adminV2DeleteCapletRecordRevision":
      return {
        kind: "stored_caplet_get",
        id: request.params.id!,
        revisionKey: request.params.revisionKey!,
      };
    case "adminV2UpdateCapletRecord":
    case "adminV2DeleteCapletRecord":
    case "adminV2PutCapletRecordCurrentRevision":
    case "adminV2PutCapletRecordBundle":
      return { kind: "stored_caplet_get", id: request.params.id! };
    default:
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `The conditional read for ${definition.operationKinds.join("/")} is unavailable.`,
      );
  }
}

function detailDefinitionForMutation(definition: AdminV2RouteDefinition): AdminV2RouteDefinition {
  let operationId: string;
  switch (definition.operationId) {
    case "adminV2UpdateRemoteClient":
    case "adminV2DeleteRemoteClient":
      operationId = "adminV2GetRemoteClient";
      break;
    case "adminV2UpdateRemoteLoginRequest":
      operationId = "adminV2GetRemoteLoginRequest";
      break;
    case "adminV2DeleteBackendAuth":
    case "adminV2RefreshBackendAuth":
      operationId = "adminV2GetBackendAuth";
      break;
    case "adminV2PutVaultValue":
    case "adminV2DeleteVaultValue":
      operationId = "adminV2GetVaultValue";
      break;
    case "adminV2PutVaultGrant":
    case "adminV2RevokeVaultAccess":
      operationId = "adminV2GetVaultGrant";
      break;
    case "adminV2DeleteCapletRecordRevision":
      operationId = "adminV2GetCapletRecordRevision";
      break;
    case "adminV2CreateCapletRecordInstallationObservation":
    case "adminV2PutCapletRecordInstallation":
    case "adminV2DeleteCapletRecordInstallation":
      operationId = "adminV2GetCapletRecordInstallation";
      break;
    default:
      operationId = "adminV2GetCapletRecord";
      break;
  }
  const detail = ADMIN_V2_ROUTE_DEFINITIONS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!detail) {
    throw new CapletsError("INTERNAL_ERROR", "The conditional Admin detail route is missing.");
  }
  return detail;
}

function operationForMutation(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  expectedGeneration: number | undefined,
): CurrentHostOperation {
  const body = request.body ?? {};
  switch (definition.operationId) {
    case "adminV2CreateRuntimeRestart":
      return { kind: "runtime_restart" };
    case "adminV2InstallCatalogCaplets":
      return { kind: "catalog_install", ...body } as CurrentHostOperation;
    case "adminV2UpdateCatalogCaplets": {
      const { acknowledgeRiskIncrease, ...rest } = body;
      return {
        kind: "catalog_update",
        ...rest,
        ...(acknowledgeRiskIncrease === undefined
          ? {}
          : { allowRiskIncrease: acknowledgeRiskIncrease }),
      } as CurrentHostOperation;
    }
    case "adminV2UpdateRemoteClient":
      if (
        expectedGeneration === undefined ||
        (body.role !== "access" && body.role !== "operator")
      ) {
        throw new CapletsError("REQUEST_INVALID", "A role and current client ETag are required.");
      }
      return {
        kind: "client_change_role",
        clientId: request.params.clientId!,
        role: body.role,
        expectedGeneration,
      };
    case "adminV2DeleteRemoteClient":
      if (expectedGeneration === undefined) {
        throw new CapletsError("INTERNAL_ERROR", "The remote client generation is unavailable.");
      }
      return {
        kind: "client_revoke",
        clientId: request.params.clientId!,
        expectedGeneration,
      };
    case "adminV2UpdateRemoteLoginRequest":
      if (expectedGeneration === undefined) {
        throw new CapletsError("INTERNAL_ERROR", "The login request generation is unavailable.");
      }
      if (body.action === "approve") {
        return {
          kind: "pending_login_approve",
          flowId: request.params.flowId!,
          ...(body.grantedRole === "access" || body.grantedRole === "operator"
            ? { grantedRole: body.grantedRole }
            : {}),
          expectedGeneration,
        };
      }
      if (body.action === "deny") {
        return {
          kind: "pending_login_deny",
          flowId: request.params.flowId!,
          expectedGeneration,
        };
      }
      throw new CapletsError("REQUEST_INVALID", "A login approval or denial action is required.");
    case "adminV2DeleteBackendAuth":
      if (expectedGeneration === undefined) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "The backend auth connection generation is unavailable.",
        );
      }
      return {
        kind: "backend_auth_connection_delete",
        server: request.params.serverId!,
        expectedGeneration,
      };
    case "adminV2StartBackendAuthFlow":
      if (typeof body.serverId !== "string") {
        throw new CapletsError("REQUEST_INVALID", "A backend server ID is required.");
      }
      return { kind: "backend_auth_flow_start", server: body.serverId };
    case "adminV2RefreshBackendAuth":
      if (typeof body.serverId !== "string" || expectedGeneration === undefined) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "A backend server ID and current connection ETag are required.",
        );
      }
      return {
        kind: "backend_auth_refresh",
        server: body.serverId,
        expectedGeneration,
      };
    case "adminV2PutVaultValue":
      if (
        typeof body.value !== "string" ||
        (!request.creating && expectedGeneration === undefined)
      ) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "A Vault value and valid creation or current-resource condition are required.",
        );
      }
      return {
        kind: "vault_set",
        name: request.params.storedKey!,
        value: body.value,
        ...(typeof body.grant === "string" ? { grant: body.grant } : {}),
        ...(typeof body.referenceName === "string" ? { referenceName: body.referenceName } : {}),
        ...(request.expectedGrantResourceVersion === undefined
          ? {}
          : { expectedGrantResourceVersion: request.expectedGrantResourceVersion }),
        ...(request.creatingGrant ? { grantCreateOnly: true } : {}),
        ...(request.creating ? { createOnly: true } : { expectedGeneration }),
      };
    case "adminV2DeleteVaultValue":
      if (expectedGeneration === undefined) {
        throw new CapletsError("INTERNAL_ERROR", "The Vault value generation is unavailable.");
      }
      return {
        kind: "vault_delete",
        name: request.params.storedKey!,
        expectedGeneration,
      };
    case "adminV2PutVaultGrant":
      if (!request.creating && !request.expectedResourceVersion) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "The Vault grant resource version is unavailable.",
        );
      }
      return {
        kind: "vault_access_grant",
        storedKey: request.params.storedKey!,
        capletId: request.params.capletId!,
        referenceName: request.params.referenceName!,
        ...(request.creating
          ? { createOnly: true }
          : { expectedResourceVersion: request.expectedResourceVersion }),
      };
    case "adminV2RevokeVaultAccess":
      if (!request.expectedResourceVersion) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "The Vault grant resource version is unavailable.",
        );
      }
      return {
        kind: "vault_access_revoke",
        storedKey: request.params.storedKey!,
        capletId: request.params.capletId!,
        referenceName: request.params.referenceName!,
        expectedResourceVersion: request.expectedResourceVersion,
      };
    case "adminV2UpdateCapletRecord": {
      if (expectedGeneration === undefined) {
        throw new CapletsError("INTERNAL_ERROR", "The Caplet Record generation is unavailable.");
      }
      const changes = [
        typeof body.document === "string",
        typeof body.id === "string",
        typeof body.historyLimit === "number" || body.historyLimit === null,
      ].filter(Boolean).length;
      if (changes !== 1) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "A Caplet Record patch must change exactly one field.",
        );
      }
      return {
        kind: "stored_caplet_update",
        id: request.params.id!,
        ...(typeof body.document === "string" ? { document: body.document } : {}),
        ...(typeof body.id === "string" ? { newId: body.id } : {}),
        ...(typeof body.historyLimit === "number" || body.historyLimit === null
          ? { historyLimit: body.historyLimit }
          : {}),
        expectedGeneration,
      };
    }
    case "adminV2DeleteCapletRecord":
      if (expectedGeneration === undefined) {
        throw new CapletsError("INTERNAL_ERROR", "The Caplet Record generation is unavailable.");
      }
      return {
        kind: "stored_caplet_delete",
        id: request.params.id!,
        expectedGeneration,
      };
    case "adminV2DeleteCapletRecordRevision":
      if (expectedGeneration === undefined) {
        throw new CapletsError("INTERNAL_ERROR", "The Caplet Record generation is unavailable.");
      }
      return {
        kind: "stored_caplet_delete_revision",
        id: request.params.id!,
        revisionKey: request.params.revisionKey!,
        expectedGeneration,
      };
    case "adminV2PutCapletRecordCurrentRevision":
      if (expectedGeneration === undefined || typeof body.revisionKey !== "string") {
        throw new CapletsError("REQUEST_INVALID", "A revision key and current ETag are required.");
      }
      return {
        kind: "stored_caplet_restore_revision",
        id: request.params.id!,
        revisionKey: body.revisionKey,
        expectedGeneration,
      };
    case "adminV2PutCapletRecordBundle": {
      if (!request.bundleUpload) {
        throw new CapletsError("INTERNAL_ERROR", "The parsed Caplet Bundle upload is unavailable.");
      }
      const manifest = request.bundleUpload.manifest;
      if (request.creating) {
        return {
          kind: "stored_caplet_bundle_import",
          id: request.params.id!,
          sources: request.bundleUpload.files,
          ...(typeof manifest.historyLimit === "number"
            ? { historyLimit: manifest.historyLimit }
            : {}),
          ...(manifest.sourceRevision ? { sourceRevision: manifest.sourceRevision } : {}),
          ...(manifest.sourceContentHash ? { sourceContentHash: manifest.sourceContentHash } : {}),
          ...(manifest.installation === undefined ? {} : { installation: manifest.installation }),
        };
      }
      if (manifest.installation !== undefined) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Caplet Installation metadata is only accepted when creating a Caplet Record.",
        );
      }
      if (expectedGeneration === undefined) {
        throw new CapletsError("INTERNAL_ERROR", "The Caplet Record generation is unavailable.");
      }
      return {
        kind: "stored_caplet_bundle_update",
        id: request.params.id!,
        sources: request.bundleUpload.files,
        expectedGeneration,
        ...(typeof manifest.historyLimit === "number"
          ? { historyLimit: manifest.historyLimit }
          : {}),
        ...(manifest.sourceRevision ? { sourceRevision: manifest.sourceRevision } : {}),
        ...(manifest.sourceContentHash ? { sourceContentHash: manifest.sourceContentHash } : {}),
        ...(manifest.detachInstallation === undefined
          ? {}
          : { detachInstallation: manifest.detachInstallation }),
      };
    }
    case "adminV2PutCapletRecordInstallation": {
      if (typeof body.sourceKind !== "string" || typeof body.sourceIdentity !== "string") {
        throw new CapletsError("REQUEST_INVALID", "A Caplet Installation source is required.");
      }
      const source = {
        sourceKind: body.sourceKind,
        sourceIdentity: body.sourceIdentity,
        ...(typeof body.channel === "string" ? { channel: body.channel } : {}),
      };
      if (request.creating) {
        return {
          kind: "stored_caplet_installation_put",
          id: request.params.id!,
          installationKey: request.params.installationKey!,
          createOnly: true,
          ...source,
        };
      }
      if (expectedGeneration === undefined) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "The Caplet Installation generation is unavailable.",
        );
      }
      return {
        kind: "stored_caplet_installation_put",
        id: request.params.id!,
        installationKey: request.params.installationKey!,
        expectedGeneration,
        ...source,
      };
    }
    case "adminV2DeleteCapletRecordInstallation":
      if (expectedGeneration === undefined) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "The Caplet Installation generation is unavailable.",
        );
      }
      return {
        kind: "stored_caplet_installation_delete",
        id: request.params.id!,
        installationKey: request.params.installationKey!,
        expectedGeneration,
      };
    case "adminV2CreateCapletRecordInstallationObservation":
      if (
        expectedGeneration === undefined ||
        (body.status !== "current" &&
          body.status !== "metadata-only" &&
          body.status !== "source-unavailable")
      ) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "An observation status and current Caplet Installation ETag are required.",
        );
      }
      return {
        kind: "stored_caplet_installation_observe",
        id: request.params.id!,
        expectedGeneration,
        status: body.status,
        ...(body.resolvedRevision === null || typeof body.resolvedRevision === "string"
          ? { resolvedRevision: body.resolvedRevision }
          : {}),
        ...(body.contentHash === null || typeof body.contentHash === "string"
          ? { contentHash: body.contentHash }
          : {}),
        ...(body.risk === null ||
        (typeof body.risk === "object" && body.risk !== undefined && !Array.isArray(body.risk))
          ? { risk: body.risk as Record<string, unknown> | null }
          : {}),
      };
    default:
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `The ${definition.operationKinds.join("/")} semantic operation is unavailable.`,
      );
  }
}

function generationFromOutcome(outcome: unknown): number | undefined {
  if (!outcome || typeof outcome !== "object") return undefined;
  if ("generation" in outcome && typeof outcome.generation === "number") {
    return outcome.generation;
  }
  if ("headGeneration" in outcome && typeof outcome.headGeneration === "number") {
    return outcome.headGeneration;
  }
  for (const value of Object.values(outcome)) {
    const generation = generationFromOutcome(value);
    if (generation !== undefined) return generation;
  }
  return undefined;
}
function resourceVersionFromOutcome(outcome: unknown): string | undefined {
  if (!outcome || typeof outcome !== "object") return undefined;
  if ("resourceVersion" in outcome && typeof outcome.resourceVersion === "string") {
    return outcome.resourceVersion;
  }
  for (const value of Object.values(outcome)) {
    const resourceVersion = resourceVersionFromOutcome(value);
    if (resourceVersion !== undefined) return resourceVersion;
  }
  return undefined;
}

function materializeRelativePath(relativePath: string, params: Record<string, string>): string {
  return relativePath.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
}

function mountRelativeResourcePath(
  requestUrl: string,
  requestRelativePath: string,
  targetRelativePath: string,
): string {
  if (!requestRelativePath.startsWith("/") || !targetRelativePath.startsWith("/")) {
    throw new CapletsError("INTERNAL_ERROR", "Admin resource paths must be root-relative.");
  }
  const requestSegments = new URL(requestUrl).pathname.split("/").filter(Boolean);
  const relativeSegments = requestRelativePath.split("/").filter(Boolean);
  if (requestSegments.length < relativeSegments.length) {
    throw new CapletsError("INTERNAL_ERROR", "The active Admin mount could not be derived.");
  }
  const mountSegments = requestSegments.slice(0, requestSegments.length - relativeSegments.length);
  const targetSegments = targetRelativePath.split("/").filter(Boolean);
  return `/${[...mountSegments, ...targetSegments].join("/")}`;
}

function reconciliationRelativePaths(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  currentResourcePath: string,
  renamedResourcePath: string | undefined,
): string[] {
  const recordPath = `/caplet-records/${encodeURIComponent(request.params.id ?? "")}`;
  let paths: string[];
  switch (definition.operationId) {
    case "adminV2CreateRuntimeRestart":
      paths = ["/runtime"];
      break;
    case "adminV2InstallCatalogCaplets":
      paths = ["/caplet-records", "/catalog/update-candidates"];
      break;
    case "adminV2UpdateCatalogCaplets":
      paths = ["/catalog/update-candidates", "/caplet-records"];
      break;
    case "adminV2StartBackendAuthFlow":
      paths = ["/backend-auth-connections"];
      break;
    case "adminV2RefreshBackendAuth":
      paths =
        typeof request.body?.serverId === "string"
          ? [`/backend-auth-connections/${encodeURIComponent(request.body.serverId)}`]
          : ["/backend-auth-connections"];
      break;
    case "adminV2PutCapletRecordCurrentRevision":
      paths = [
        recordPath,
        ...(typeof request.body?.revisionKey === "string"
          ? [`${recordPath}/revisions/${encodeURIComponent(request.body.revisionKey)}`]
          : []),
      ];
      break;
    case "adminV2CreateCapletRecordInstallationObservation":
      paths = [`${recordPath}/installations`];
      break;
    case "adminV2PutCapletRecordInstallation":
      paths = [`${recordPath}/installations`, currentResourcePath];
      break;
    default:
      paths =
        renamedResourcePath !== undefined && renamedResourcePath !== currentResourcePath
          ? [renamedResourcePath, currentResourcePath]
          : [currentResourcePath];
      break;
  }
  return [...new Set(paths)];
}

function mutationLocation(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  body: unknown,
  requestUrl: string,
  requestRelativePath: string,
  currentResourcePath: string,
  renamedResourcePath: string | undefined,
): string | undefined {
  if (renamedResourcePath !== undefined) return renamedResourcePath;
  const bodyFlowId = stringFromRepresentation(body, ["flowId"]);
  const bodyServer = stringFromRepresentation(body, ["serverId", "server"]);
  const bodyInstallationKey = stringFromRepresentation(body, ["installationKey"]);
  switch (definition.operationId) {
    case "adminV2StartBackendAuthFlow":
      return mountRelativeResourcePath(
        requestUrl,
        requestRelativePath,
        bodyFlowId !== undefined
          ? `/backend-auth-flows/${encodeURIComponent(bodyFlowId)}`
          : `/backend-auth-connections/${encodeURIComponent(bodyServer ?? "")}`,
      );
    case "adminV2PutCapletRecordInstallation":
      if (bodyInstallationKey === undefined) return undefined;
      return mountRelativeResourcePath(
        requestUrl,
        requestRelativePath,
        `/caplet-records/${encodeURIComponent(request.params.id ?? "")}/installations/${encodeURIComponent(bodyInstallationKey)}`,
      );
    case "adminV2CreateCapletRecordInstallationObservation":
      if (bodyInstallationKey === undefined) return undefined;
      return mountRelativeResourcePath(
        requestUrl,
        requestRelativePath,
        `/caplet-records/${encodeURIComponent(request.params.id ?? "")}/installations/${encodeURIComponent(bodyInstallationKey)}`,
      );
    case "adminV2InstallCatalogCaplets":
      return mountRelativeResourcePath(requestUrl, requestRelativePath, "/caplet-records");
    case "adminV2UpdateCatalogCaplets":
      return mountRelativeResourcePath(
        requestUrl,
        requestRelativePath,
        "/catalog/update-candidates",
      );
    case "adminV2CreateRuntimeRestart":
      return mountRelativeResourcePath(requestUrl, requestRelativePath, "/runtime");
    default:
      return request.creating || definition.created ? currentResourcePath : undefined;
  }
}

function validateSafeRequest(
  context: Context,
  definition: AdminV2RouteDefinition,
): ValidatedRouteRequest {
  const paramsResult = definition.params?.safeParse(context.req.param());
  if (paramsResult && !paramsResult.success) {
    throw new CapletsError("REQUEST_INVALID", "Admin route parameters are invalid.");
  }

  const rawQuery = Object.fromEntries(new URL(context.req.url).searchParams.entries());
  const queryResult = definition.query?.safeParse(rawQuery);
  if (queryResult && !queryResult.success) {
    throw new CapletsError("REQUEST_INVALID", "Admin route query parameters are invalid.");
  }
  return {
    params: (paramsResult?.data ?? context.req.param()) as Record<string, string>,
    query: (queryResult?.data ?? rawQuery) as Record<string, unknown>,
  };
}

function operationForSafeRoute(
  definition: AdminV2RouteDefinition,
  request: ValidatedRouteRequest,
  host: AdminV2HostContext,
): CurrentHostOperation {
  const limit = request.query.limit as number | undefined;
  const sort = cursorSort(request.query);
  const filters = cursorFilters(request.query);
  const cursorResourcePath = materializeRelativePath(definition.relativePath, request.params);
  const decodeCursor = <TKeySchema extends z.ZodType>(schema: TKeySchema) =>
    typeof request.query.cursor === "string"
      ? createCursorCodec({
          route: cursorResourcePath,
          filters,
          direction: sort,
          stableKeySchema: schema,
        }).decode(request.query.cursor)
      : undefined;

  switch (definition.operationId) {
    case "adminV2GetHost":
      return {
        kind: "summary",
        baseUrl: host.baseUrl,
        dashboardUrl: host.dashboardUrl,
        dashboardPath: host.dashboardPath,
      };
    case "adminV2GetRuntime":
      return {
        kind: "runtime",
        baseUrl: host.baseUrl,
        bind: host.bind,
        publicOrigin: host.publicOrigin ?? null,
      };
    case "adminV2ListLogs": {
      const after = decodeCursor(logPageKeySchema);
      return {
        kind: "logs",
        sort,
        ...(limit === undefined ? {} : { limit }),
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2GetDiagnostics":
      return { kind: "diagnostics" };
    case "adminV2GetProjectBinding":
      return { kind: "project_binding" };
    case "adminV2ListEvents":
      return { kind: "runtime_event" };
    case "adminV2ListActivity": {
      const after = decodeCursor(activityPageKeySchema);
      return {
        kind: "activity_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
        ...(typeof request.query.action === "string" ? { action: request.query.action } : {}),
      };
    }
    case "adminV2ListEffectiveCaplets": {
      const after = decodeCursor(capletPageKeySchema);
      return {
        kind: "caplets_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2ListCatalogEntries": {
      const after = decodeCursor(catalogEntryPageKeySchema);
      return {
        kind: "catalog_entries_page",
        source: request.query.source as string,
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(typeof request.query.query === "string" ? { query: request.query.query } : {}),
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2GetCatalogEntry":
      return {
        kind: "catalog_detail",
        source: request.query.source as string,
        entryKey: request.params.entryKey!,
      };
    case "adminV2ListCatalogUpdateCandidates": {
      const after = decodeCursor(catalogUpdatePageKeySchema);
      return {
        kind: "catalog_update_candidates_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2ListRemoteClients": {
      const after = decodeCursor(remoteClientPageKeySchema);
      return {
        kind: "remote_clients_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
        ...(typeof request.query.role === "string"
          ? { role: request.query.role as "access" | "operator" }
          : {}),
        ...(typeof request.query.revoked === "string"
          ? { revoked: request.query.revoked === "true" }
          : {}),
      };
    }
    case "adminV2GetRemoteClient":
      return { kind: "remote_client_get", clientId: request.params.clientId! };
    case "adminV2ListRemoteLoginRequests": {
      const after = decodeCursor(pendingLoginPageKeySchema);
      return {
        kind: "remote_login_requests_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
        ...(typeof request.query.status === "string"
          ? { statuses: request.query.status.split(",") as never }
          : {}),
      };
    }
    case "adminV2GetRemoteLoginRequest":
      return { kind: "remote_login_request_get", flowId: request.params.flowId! };
    case "adminV2ListBackendAuth": {
      const after = decodeCursor(backendConnectionPageKeySchema);
      return {
        kind: "backend_auth_connections_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2GetBackendAuth":
      return { kind: "backend_auth_connection_get", server: request.params.serverId! };
    case "adminV2GetBackendAuthFlow":
      return { kind: "backend_auth_flow_get", flowId: request.params.flowId! };
    case "adminV2ListVaultValues": {
      const after = decodeCursor(vaultValuePageKeySchema);
      return {
        kind: "vault_values_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2ListVaultGrants":
    case "adminV2ListVaultValueGrants": {
      const after = decodeCursor(vaultGrantPageKeySchema);
      return {
        kind: "vault_grants_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
        ...(request.params.storedKey
          ? { storedKey: request.params.storedKey }
          : typeof request.query.storedKey === "string"
            ? { storedKey: request.query.storedKey }
            : {}),
        ...(typeof request.query.capletId === "string" ? { capletId: request.query.capletId } : {}),
      };
    }
    case "adminV2GetVaultGrant":
      return {
        kind: "vault_access_list",
        storedKey: request.params.storedKey!,
        capletId: request.params.capletId!,
        referenceName: request.params.referenceName!,
      };
    case "adminV2GetVaultValue":
      return { kind: "vault_get", name: request.params.storedKey! };
    case "adminV2GetCapletRecord":
      return { kind: "stored_caplet_get", id: request.params.id! };
    case "adminV2GetCapletRecordRevision":
      return {
        kind: "stored_caplet_get",
        id: request.params.id!,
        revisionKey: request.params.revisionKey!,
      };
    case "adminV2ListCapletRecords": {
      const after = decodeCursor(capletRecordPageKeySchema);
      return {
        kind: "stored_caplets_page",
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
        ...(typeof request.query.source === "string" ? { source: request.query.source } : {}),
        ...(request.query.status === "active" || request.query.status === "detached"
          ? { status: request.query.status }
          : {}),
        ...(typeof request.query.tag === "string" ? { tag: request.query.tag } : {}),
        ...(typeof request.query.search === "string" ? { search: request.query.search } : {}),
      };
    }
    case "adminV2ListCapletRecordRevisions": {
      const after = decodeCursor(capletRevisionPageKeySchema);
      return {
        kind: "stored_caplet_revisions_page",
        id: request.params.id!,
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2ListCapletRecordInstallations": {
      const after = decodeCursor(capletInstallationPageKeySchema);
      return {
        kind: "stored_caplet_installations_page",
        id: request.params.id!,
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2ListCapletRecordInstallationObservations": {
      const after = decodeCursor(capletInstallationObservationPageKeySchema);
      return {
        kind: "stored_caplet_installation_observations_page",
        id: request.params.id!,
        limit: limit ?? DEFAULT_PAGE_LIMIT,
        sort,
        ...(after === undefined ? {} : { after }),
      };
    }
    case "adminV2GetCapletRecordInstallation":
      return {
        kind: "stored_caplet_installation_get",
        id: request.params.id!,
        installationKey: request.params.installationKey!,
      };
    default:
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `The ${definition.operationKinds.join("/")} semantic operation is unavailable.`,
      );
  }
}

async function executeOperation(
  operations: CurrentHostOperations,
  principal: CurrentHostPrincipal,
  operation: CurrentHostOperation,
): Promise<SemanticOutcome> {
  return (await operations.execute(principal, operation)) as SemanticOutcome;
}

function responseBodyForOutcome(
  definition: AdminV2RouteDefinition,
  outcome: SemanticOutcome,
  request: ValidatedRouteRequest,
): unknown {
  if (outcome.status === "not_found") {
    throw new CapletsError("SERVER_NOT_FOUND", "The requested Admin resource was not found.");
  }
  if (definition.operationId === "adminV2GetVaultValue" && outcome.present === false) {
    throw new CapletsError("SERVER_NOT_FOUND", "The requested Vault value was not found.");
  }
  switch (definition.operationId) {
    case "adminV2InstallCatalogCaplets":
    case "adminV2UpdateCatalogCaplets":
      return catalogMutationSummaryForResponse(outcome);
    case "adminV2GetRemoteClient":
    case "adminV2UpdateRemoteClient":
      return outcome.client;
    case "adminV2DeleteRemoteClient":
      if (
        outcome.status === "revoked" &&
        outcome.client &&
        typeof outcome.client === "object" &&
        "clientId" in outcome.client &&
        typeof outcome.client.clientId === "string"
      ) {
        return {
          revoked: true,
          clientId: outcome.client.clientId,
          sessionEnded: outcome.sessionEnded === true,
        };
      }
      break;
    case "adminV2GetRemoteLoginRequest":
    case "adminV2UpdateRemoteLoginRequest":
      return outcome.pendingLogin;
    case "adminV2CreateRuntimeRestart":
      if (outcome.restartAvailable !== true) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Runtime restart is unavailable on this Host Node.",
        );
      }
      return { restartAvailable: true };
    case "adminV2GetVaultGrant":
      if (Array.isArray(outcome.grants)) {
        const grant = outcome.grants.find(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            "storedKey" in candidate &&
            candidate.storedKey === request.params.storedKey &&
            "capletId" in candidate &&
            candidate.capletId === request.params.capletId &&
            "referenceName" in candidate &&
            candidate.referenceName === request.params.referenceName,
        );
        if (grant) return grant;
      }
      throw new CapletsError("SERVER_NOT_FOUND", "The requested Vault grant was not found.");
    case "adminV2PutVaultGrant":
    case "adminV2RevokeVaultAccess":
      if (Array.isArray(outcome.grants)) {
        const grant = outcome.grants.find(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            "referenceName" in candidate &&
            candidate.referenceName === request.params.referenceName,
        );
        if (!grant) {
          throw new CapletsError("SERVER_NOT_FOUND", "The requested Vault grant was not found.");
        }
        return grant;
      }
      return definition.operationId === "adminV2PutVaultGrant"
        ? outcome.grant
        : { revoked: outcome.revoked };
    case "adminV2UpdateCapletRecord":
    case "adminV2PutCapletRecordBundle":
    case "adminV2PutCapletRecordCurrentRevision":
      return capletRecordSummaryForResponse(outcome.record);
    case "adminV2DeleteCapletRecordRevision":
      return outcome.record === undefined
        ? {}
        : { record: capletRecordSummaryForResponse(outcome.record) };
    case "adminV2GetCapletRecordInstallation":
      return outcome.installation;
    case "adminV2PutCapletRecordInstallation":
      return installationMutationSummaryForResponse(outcome.installation);
    case "adminV2DeleteCapletRecordInstallation":
      if (
        outcome.installation &&
        typeof outcome.installation === "object" &&
        "installationKey" in outcome.installation &&
        typeof outcome.installation.installationKey === "string" &&
        "capletId" in outcome.installation &&
        typeof outcome.installation.capletId === "string"
      ) {
        return {
          installationKey: outcome.installation.installationKey,
          capletId: outcome.installation.capletId,
          deleted: true,
        };
      }
      break;
    case "adminV2CreateCapletRecordInstallationObservation":
      return installationObservationMutationSummaryForResponse(outcome.observation);
  }
  if (definition.page) {
    const semanticPage = outcome.page as { items: unknown[]; nextKey?: unknown } | undefined;
    if (semanticPage) {
      const page: { items: unknown[]; nextCursor?: string } = { items: semanticPage.items };
      if (semanticPage.nextKey !== undefined) {
        const stableKeySchema = stableKeySchemaForRoute(definition.operationId);
        page.nextCursor = createCursorCodec({
          route: materializeRelativePath(definition.relativePath, request.params),
          filters: cursorFilters(request.query),
          direction: cursorSort(request.query),
          stableKeySchema,
        }).encode(semanticPage.nextKey);
      }
      return page;
    }
    if (outcome.activity && typeof outcome.activity === "object") {
      const activity = outcome.activity as { entries?: unknown[]; nextCursor?: string };
      const page: { items: unknown[]; nextCursor?: string } = { items: activity.entries ?? [] };
      if (activity.nextCursor) {
        page.nextCursor = createCursorCodec({
          route: materializeRelativePath(definition.relativePath, request.params),
          filters: cursorFilters(request.query),
          direction: cursorSort(request.query),
          stableKeySchema: z.string().min(1),
        }).encode(activity.nextCursor);
      }
      return page;
    }
    if (Array.isArray(outcome.caplets)) return { items: outcome.caplets };
    if (Array.isArray(outcome.records)) return { items: outcome.records };
    if (Array.isArray(outcome.revisions)) return { items: outcome.revisions };
    if (Array.isArray(outcome.entries)) return { items: outcome.entries };
    if (Array.isArray(outcome.updates)) return { items: outcome.updates };
    if (Array.isArray(outcome.grants)) return { items: outcome.grants };
  }

  const representation = Object.fromEntries(
    Object.entries(outcome).filter(([key]) => key !== "kind"),
  );
  const entries = Object.entries(representation);
  return entries.length === 1 ? entries[0]![1] : representation;
}

function catalogMutationSummaryForResponse(outcome: SemanticOutcome): CatalogMutationSummary {
  if (!Array.isArray(outcome.installed) || !Array.isArray(outcome.setupActions)) {
    throw new CapletsError("INTERNAL_ERROR", "The Catalog mutation result is malformed.");
  }
  const installed = outcome.installed.slice(0, ADMIN_CATALOG_MUTATION_MAX_CAPLETS).map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("kind" in value) ||
      (value.kind !== "file" && value.kind !== "directory")
    ) {
      throw new CapletsError("INTERNAL_ERROR", "The Catalog mutation result is malformed.");
    }
    const summary: CatalogMutationInstalledSummary = { kind: value.kind };
    if (
      "status" in value &&
      (value.status === "installed" ||
        value.status === "restored" ||
        value.status === "updated" ||
        value.status === "content_updated" ||
        value.status === "noop")
    ) {
      summary.status = value.status;
    }
    if (
      "catalogIndexing" in value &&
      value.catalogIndexing &&
      typeof value.catalogIndexing === "object" &&
      "status" in value.catalogIndexing &&
      (value.catalogIndexing.status === "accepted" ||
        value.catalogIndexing.status === "already_current" ||
        value.catalogIndexing.status === "counted" ||
        value.catalogIndexing.status === "ineligible" ||
        value.catalogIndexing.status === "rate_limited" ||
        value.catalogIndexing.status === "rejected" ||
        value.catalogIndexing.status === "revision_unavailable" ||
        value.catalogIndexing.status === "suppressed" ||
        value.catalogIndexing.status === "unavailable")
    ) {
      summary.catalogIndexing = { status: value.catalogIndexing.status };
    }
    return summary;
  });
  const setupActions = outcome.setupActions.slice(0, 6).map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("kind" in value) ||
      (value.kind !== "auth" &&
        value.kind !== "vault" &&
        value.kind !== "project_binding" &&
        value.kind !== "backend_check" &&
        value.kind !== "exposure_validation" &&
        value.kind !== "code_mode") ||
      !("required" in value) ||
      typeof value.required !== "boolean"
    ) {
      throw new CapletsError("INTERNAL_ERROR", "The Catalog mutation result is malformed.");
    }
    return { kind: value.kind, required: value.required };
  });
  return {
    installed,
    installedCount: outcome.installed.length,
    setupActions,
    setupActionCount: outcome.setupActions.length,
  };
}

function installationMutationSummaryForResponse(value: unknown): {
  installationKey: string;
  capletId: string;
  recordKey: string;
  generation: number;
  status: "active" | "detached";
  createdAt: string;
  updatedAt: string;
  detachedAt: string | null;
} {
  if (
    !value ||
    typeof value !== "object" ||
    !("installationKey" in value) ||
    typeof value.installationKey !== "string" ||
    !("capletId" in value) ||
    typeof value.capletId !== "string" ||
    !("recordKey" in value) ||
    typeof value.recordKey !== "string" ||
    !("generation" in value) ||
    typeof value.generation !== "number" ||
    !("status" in value) ||
    (value.status !== "active" && value.status !== "detached") ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string" ||
    !("detachedAt" in value) ||
    (value.detachedAt !== null && typeof value.detachedAt !== "string")
  ) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "The Caplet Installation mutation result is malformed.",
    );
  }
  return {
    installationKey: value.installationKey,
    capletId: value.capletId,
    recordKey: value.recordKey,
    generation: value.generation,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    detachedAt: value.detachedAt,
  };
}

function installationObservationMutationSummaryForResponse(value: unknown): {
  observationKey: string;
  installationKey: string;
  resolvedRevision: string | null;
  contentHash: string | null;
  status: "current" | "metadata-only" | "source-unavailable";
  observedAt: string;
} {
  if (
    !value ||
    typeof value !== "object" ||
    !("observationKey" in value) ||
    typeof value.observationKey !== "string" ||
    !("installationKey" in value) ||
    typeof value.installationKey !== "string" ||
    !("resolvedRevision" in value) ||
    (value.resolvedRevision !== null && typeof value.resolvedRevision !== "string") ||
    !("contentHash" in value) ||
    (value.contentHash !== null && typeof value.contentHash !== "string") ||
    !("status" in value) ||
    (value.status !== "current" &&
      value.status !== "metadata-only" &&
      value.status !== "source-unavailable") ||
    !("observedAt" in value) ||
    typeof value.observedAt !== "string"
  ) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "The Caplet Installation Observation mutation result is malformed.",
    );
  }
  return {
    observationKey: value.observationKey,
    installationKey: value.installationKey,
    resolvedRevision: value.resolvedRevision,
    contentHash: value.contentHash,
    status: value.status,
    observedAt: value.observedAt,
  };
}

function capletRecordSummaryForResponse(value: unknown): CapletRecordSummaryView {
  if (
    !value ||
    typeof value !== "object" ||
    !("recordKey" in value) ||
    typeof value.recordKey !== "string" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("headGeneration" in value) ||
    typeof value.headGeneration !== "number" ||
    !("historyLimit" in value) ||
    (value.historyLimit !== null && typeof value.historyLimit !== "number") ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string" ||
    !("currentRevision" in value) ||
    !value.currentRevision ||
    typeof value.currentRevision !== "object" ||
    !("revisionKey" in value.currentRevision) ||
    typeof value.currentRevision.revisionKey !== "string" ||
    !("sequence" in value.currentRevision) ||
    typeof value.currentRevision.sequence !== "number" ||
    !("name" in value.currentRevision) ||
    typeof value.currentRevision.name !== "string" ||
    !("createdAt" in value.currentRevision) ||
    typeof value.currentRevision.createdAt !== "string"
  ) {
    throw new CapletsError("INTERNAL_ERROR", "The Caplet Record mutation result is malformed.");
  }
  return {
    recordKey: value.recordKey,
    id: value.id,
    headGeneration: value.headGeneration,
    historyLimit: value.historyLimit,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    currentRevision: {
      revisionKey: value.currentRevision.revisionKey,
      sequence: value.currentRevision.sequence,
      name: value.currentRevision.name,
      createdAt: value.currentRevision.createdAt,
    },
  };
}

function stableKeySchemaForRoute(operationId: string): z.ZodType {
  switch (operationId) {
    case "adminV2ListLogs":
      return logPageKeySchema;
    case "adminV2ListActivity":
      return activityPageKeySchema;
    case "adminV2ListEffectiveCaplets":
      return capletPageKeySchema;
    case "adminV2ListCatalogEntries":
      return catalogEntryPageKeySchema;
    case "adminV2ListCatalogUpdateCandidates":
      return catalogUpdatePageKeySchema;
    case "adminV2ListCapletRecords":
      return capletRecordPageKeySchema;
    case "adminV2ListCapletRecordRevisions":
      return capletRevisionPageKeySchema;
    case "adminV2ListCapletRecordInstallations":
      return capletInstallationPageKeySchema;
    case "adminV2ListCapletRecordInstallationObservations":
      return capletInstallationObservationPageKeySchema;
    case "adminV2ListRemoteClients":
      return remoteClientPageKeySchema;
    case "adminV2ListRemoteLoginRequests":
      return pendingLoginPageKeySchema;
    case "adminV2ListBackendAuth":
      return backendConnectionPageKeySchema;
    case "adminV2ListVaultValues":
      return vaultValuePageKeySchema;
    case "adminV2ListVaultGrants":
    case "adminV2ListVaultValueGrants":
      return vaultGrantPageKeySchema;
    default:
      throw new CapletsError("INTERNAL_ERROR", "The Admin cursor codec is unavailable.");
  }
}

function cursorSort(query: Record<string, unknown>): "asc" | "desc" {
  return query.sort === "desc" ? "desc" : "asc";
}

function cursorFilters(query: Record<string, unknown>): Record<string, CursorJsonValue> {
  const entries = Object.entries(query)
    .filter(
      ([key, value]) =>
        key !== "cursor" && key !== "limit" && key !== "sort" && value !== undefined,
    )
    .map(([key, value]) => [key, value as CursorJsonValue] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function etagForRepresentation(
  definition: AdminV2RouteDefinition,
  body: unknown,
  request: ValidatedRouteRequest,
): string {
  const requestedRevisionKey =
    definition.operationId === "adminV2GetCapletRecordRevision" ||
    definition.operationId === "adminV2GetCapletRecordRevisionBundle" ||
    definition.operationId === "adminV2DeleteCapletRecordRevision"
      ? request.params.revisionKey
      : undefined;
  const version =
    requestedRevisionKey ??
    resourceVersionFromOutcome(body) ??
    generationFromOutcome(body) ??
    (definition.operationId.includes("Revision")
      ? revisionKeyFromRepresentation(body)
      : undefined) ??
    JSON.stringify(body);
  const namespace = etagNamespace(definition.operationId, definition.relativePath);
  const identity = concreteResourceIdentity(namespace, definition, body, request);
  return createStrongEtag(namespace, JSON.stringify([identity, version]));
}

function concreteResourceIdentity(
  namespace: string,
  definition: AdminV2RouteDefinition,
  body: unknown,
  request: ValidatedRouteRequest,
): string {
  const bodyString = (...keys: string[]) => stringFromRepresentation(body, keys);
  switch (namespace) {
    case "admin-remote-client":
      return bodyString("clientId") ?? request.params.clientId ?? definition.relativePath;
    case "admin-remote-login-request":
      return bodyString("flowId") ?? request.params.flowId ?? definition.relativePath;
    case "admin-backend-auth-flow":
      return bodyString("flowId") ?? request.params.flowId ?? definition.relativePath;
    case "admin-backend-auth-connection":
      return bodyString("serverId", "server") ?? request.params.serverId ?? definition.relativePath;
    case "admin-vault-grant":
      return JSON.stringify([
        request.params.storedKey ?? bodyString("storedKey"),
        request.params.capletId ?? bodyString("capletId"),
        request.params.referenceName ?? bodyString("referenceName"),
      ]);
    case "admin-vault-value":
      return request.params.storedKey ?? bodyString("storedKey", "name") ?? definition.relativePath;
    case "admin-caplet-installation":
      return JSON.stringify([
        bodyString("capletId") ?? request.params.id,
        bodyString("installationKey") ?? request.params.installationKey,
      ]);
    case "admin-caplet-installation-observation":
      return JSON.stringify([
        request.params.id,
        bodyString("installationKey"),
        bodyString("observationKey"),
      ]);
    case "admin-caplet-record":
      return JSON.stringify([
        bodyString("id") ?? request.params.id,
        definition.operationId === "adminV2GetCapletRecordRevision" ||
        definition.operationId === "adminV2GetCapletRecordRevisionBundle" ||
        definition.operationId === "adminV2DeleteCapletRecordRevision"
          ? request.params.revisionKey
          : undefined,
      ]);
    default:
      return materializeRelativePath(definition.relativePath, request.params);
  }
}

function stringFromRepresentation(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    if (key in value && typeof (value as Record<string, unknown>)[key] === "string") {
      return (value as Record<string, string>)[key];
    }
  }
  for (const nested of Object.values(value)) {
    const match = stringFromRepresentation(nested, keys);
    if (match !== undefined) return match;
  }
  return undefined;
}

function revisionKeyFromRepresentation(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if ("revisionKey" in value && typeof value.revisionKey === "string") {
    return value.revisionKey;
  }
  for (const nested of Object.values(value)) {
    const revisionKey = revisionKeyFromRepresentation(nested);
    if (revisionKey) return revisionKey;
  }
  return undefined;
}

function etagNamespace(operationId: string, fallbackPath: string): string {
  if (operationId.includes("RemoteClient")) return "admin-remote-client";
  if (operationId.includes("RemoteLoginRequest")) return "admin-remote-login-request";
  if (operationId.includes("BackendAuthFlow")) return "admin-backend-auth-flow";
  if (operationId.includes("BackendAuth")) return "admin-backend-auth-connection";
  if (operationId.includes("VaultGrant") || operationId === "adminV2RevokeVaultAccess") {
    return "admin-vault-grant";
  }
  if (operationId.includes("VaultValue")) return "admin-vault-value";
  if (operationId.includes("InstallationObservation")) {
    return "admin-caplet-installation-observation";
  }
  if (operationId.includes("CapletRecordInstallation")) return "admin-caplet-installation";
  if (operationId.includes("CapletRecord")) return "admin-caplet-record";
  return fallbackPath;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": NO_STORE,
      "Content-Type": JSON_MEDIA,
      ...headers,
    },
  });
}

function reportBundleUploadCleanupError(
  error: unknown,
  reporter: ((error: SafeErrorSummary) => void) | undefined,
): void {
  const safe = toSafeError(error, "SERVER_UNAVAILABLE");
  if (reporter) {
    try {
      reporter(safe);
      return;
    } catch {
      // A reporter failure must not replace a response that is already durable.
    }
  }
  try {
    process.stderr.write(
      `Caplet Bundle upload cleanup failed after durable finalization: ${JSON.stringify(safe)}\n`,
    );
  } catch {
    // The durable response remains authoritative even if the fallback reporter is unavailable.
  }
}

function noStoreProblemResponse(error: unknown): Response {
  const response =
    error instanceof AdminV2PrincipalError
      ? problemResponse(error, { status: error.status })
      : problemResponse(error);
  response.headers.set("Cache-Control", NO_STORE);
  if (error instanceof CapletsError && error.code === "UPLOAD_CAPACITY_EXCEEDED") {
    response.headers.set("Retry-After", String(UPLOAD_CAPACITY_RETRY_AFTER_SECONDS));
  }
  return response;
}
