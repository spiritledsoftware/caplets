import {
  adminV2CreateRuntimeRestart as generatedAdminV2CreateRuntimeRestart,
  adminV2DeleteCapletRecord as generatedAdminV2DeleteCapletRecord,
  adminV2DeleteCapletRecordRevision as generatedAdminV2DeleteCapletRecordRevision,
  adminV2DeleteRemoteClient as generatedAdminV2DeleteRemoteClient,
  adminV2DeleteVaultValue as generatedAdminV2DeleteVaultValue,
  adminV2GetCapletRecord as generatedAdminV2GetCapletRecord,
  adminV2GetCapletRecordRevision as generatedAdminV2GetCapletRecordRevision,
  adminV2GetCatalogEntry as generatedAdminV2GetCatalogEntry,
  adminV2GetDiagnostics as generatedAdminV2GetDiagnostics,
  adminV2GetHost as generatedAdminV2GetHost,
  adminV2GetProjectBinding as generatedAdminV2GetProjectBinding,
  adminV2GetRemoteClient as generatedAdminV2GetRemoteClient,
  adminV2GetRemoteLoginRequest as generatedAdminV2GetRemoteLoginRequest,
  adminV2GetRuntime as generatedAdminV2GetRuntime,
  adminV2GetVaultValue as generatedAdminV2GetVaultValue,
  adminV2InstallCatalogCaplets as generatedAdminV2InstallCatalogCaplets,
  adminV2ListActivity as generatedAdminV2ListActivity,
  adminV2ListCapletRecordRevisions as generatedAdminV2ListCapletRecordRevisions,
  adminV2ListCapletRecords as generatedAdminV2ListCapletRecords,
  adminV2ListCatalogEntries as generatedAdminV2ListCatalogEntries,
  adminV2ListCatalogUpdateCandidates as generatedAdminV2ListCatalogUpdateCandidates,
  adminV2ListEffectiveCaplets as generatedAdminV2ListEffectiveCaplets,
  adminV2ListLogs as generatedAdminV2ListLogs,
  adminV2ListRemoteClients as generatedAdminV2ListRemoteClients,
  adminV2ListRemoteLoginRequests as generatedAdminV2ListRemoteLoginRequests,
  adminV2ListVaultGrants as generatedAdminV2ListVaultGrants,
  adminV2ListVaultValues as generatedAdminV2ListVaultValues,
  adminV2PutCapletRecordBundleFormData as generatedAdminV2PutCapletRecordBundleFormData,
  adminV2PutCapletRecordCurrentRevision as generatedAdminV2PutCapletRecordCurrentRevision,
  adminV2PutVaultValue as generatedAdminV2PutVaultValue,
  adminV2UpdateCapletRecord as generatedAdminV2UpdateCapletRecord,
  adminV2UpdateCatalogCaplets as generatedAdminV2UpdateCatalogCaplets,
  adminV2UpdateRemoteClient as generatedAdminV2UpdateRemoteClient,
  adminV2UpdateRemoteLoginRequest as generatedAdminV2UpdateRemoteLoginRequest,
  createClient,
  createOrderedBundleFormData,
  type AdminV2CreateRuntimeRestartResponse,
  type AdminV2DeleteCapletRecordResponse,
  type AdminV2DeleteCapletRecordRevisionResponse,
  type AdminV2DeleteRemoteClientResponse,
  type AdminV2DeleteVaultValueResponse,
  type AdminV2GetCapletRecordResponse,
  type AdminV2GetCapletRecordRevisionResponse,
  type AdminV2GetCatalogEntryResponse,
  type AdminV2GetDiagnosticsResponse,
  type AdminV2GetHostResponse,
  type AdminV2GetProjectBindingResponse,
  type AdminV2GetRemoteClientResponse,
  type AdminV2GetRemoteLoginRequestResponse,
  type AdminV2GetRuntimeResponse,
  type AdminV2GetVaultValueResponse,
  type AdminV2InstallCatalogCapletsData,
  type AdminV2InstallCatalogCapletsResponse,
  type AdminV2ListActivityResponse,
  type AdminV2ListCapletRecordRevisionsResponse,
  type AdminV2ListCapletRecordsResponse,
  type AdminV2ListCatalogEntriesResponse,
  type AdminV2ListCatalogUpdateCandidatesResponse,
  type AdminV2ListEffectiveCapletsResponse,
  type AdminV2ListLogsResponse,
  type AdminV2ListRemoteClientsResponse,
  type AdminV2ListRemoteLoginRequestsResponse,
  type AdminV2ListVaultGrantsResponse,
  type AdminV2ListVaultValuesResponse,
  type AdminV2PutCapletRecordBundleResponse,
  type AdminV2PutCapletRecordCurrentRevisionResponse,
  type AdminV2PutVaultValueData,
  type AdminV2PutVaultValueResponse,
  type AdminV2UpdateCapletRecordData,
  type AdminV2UpdateCapletRecordResponse,
  type AdminV2UpdateCatalogCapletsData,
  type AdminV2UpdateCatalogCapletsResponse,
  type AdminV2UpdateRemoteClientData,
  type AdminV2UpdateRemoteClientResponse,
  type AdminV2UpdateRemoteLoginRequestData,
  type AdminV2UpdateRemoteLoginRequestResponse,
  type Problem,
} from "@caplets/sdk";
import { dashboardApiUrl } from "./paths";

const CANONICAL_ADMIN_PATH = "/api/v2/admin";

export type DashboardSession = {
  sessionId: string;
  operatorClientId: string;
  csrfToken: string;
  role?: string;
};

export type DashboardMutationIntent = Readonly<{ idempotencyKey: string }>;

export type VersionedDashboardResource<T> = {
  data: T;
  etag: string;
};

type DashboardRequestOptions = {
  signal?: AbortSignal;
};

type DashboardListOptions = DashboardRequestOptions & {
  cursor?: string;
  limit?: number;
};

type GeneratedResult<T> =
  | { data: T; error?: undefined; response?: Response }
  | { data?: undefined; error: unknown; response?: Response };

let activeSession: DashboardSession | undefined;

export class DashboardApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code?: string;
  readonly nextAction?: string;
  readonly links?: Readonly<Record<string, string>>;

  constructor(
    message: string,
    options: {
      status: number;
      body: unknown;
      code?: string;
      nextAction?: string;
      links?: Readonly<Record<string, string>>;
    },
  ) {
    super(message);
    this.name = "DashboardApiError";
    this.status = options.status;
    this.body = options.body;
    this.code = options.code;
    this.nextAction = options.nextAction;
    this.links = options.links;
  }
}

export function setDashboardSession(session: DashboardSession | undefined) {
  activeSession = session;
}

export function csrfHeaders(session = activeSession): HeadersInit {
  return session?.csrfToken ? { "x-caplets-csrf": session.csrfToken } : {};
}

export function createDashboardMutationIntent(): DashboardMutationIntent {
  return Object.freeze({ idempotencyKey: crypto.randomUUID() });
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function dashboardRequestHeaders(method: string, initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  headers.delete("x-caplets-csrf");
  if (!isSafeMethod(method)) {
    const csrfToken = activeSession?.csrfToken;
    if (csrfToken) headers.set("x-caplets-csrf", csrfToken);
  }
  return headers;
}

async function dashboardGeneratedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const requestUrl = new URL(request.url);
  const adminPath = CANONICAL_ADMIN_PATH;
  if (requestUrl.pathname !== adminPath && !requestUrl.pathname.startsWith(`${adminPath}/`)) {
    throw new Error(`Generated Admin request escaped the canonical mount: ${requestUrl.pathname}`);
  }
  const method = request.method.toUpperCase();
  return globalThis.fetch(
    new Request(request, {
      credentials: "same-origin",
      headers: dashboardRequestHeaders(method, request.headers),
    }),
  );
}

let configuredAdminClient: { baseUrl: string; client: ReturnType<typeof createClient> } | undefined;

function dashboardAdminClient(): ReturnType<typeof createClient> {
  const baseUrl =
    typeof globalThis.location === "undefined" || globalThis.location.origin === "null"
      ? "http://localhost"
      : globalThis.location.origin;
  if (configuredAdminClient?.baseUrl === baseUrl) return configuredAdminClient.client;
  const client = createClient({
    auth: () => undefined,
    baseUrl,
    credentials: "same-origin",
    fetch: dashboardGeneratedFetch,
    responseStyle: "fields",
    throwOnError: false,
  });
  configuredAdminClient = { baseUrl, client };
  return client;
}

function isProblem(value: unknown): value is Problem {
  if (!value || typeof value !== "object") return false;
  return (
    "type" in value &&
    typeof value.type === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    "status" in value &&
    typeof value.status === "number" &&
    "detail" in value &&
    typeof value.detail === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function apiError(error: unknown, response?: Response): DashboardApiError {
  if (isProblem(error)) {
    return new DashboardApiError(error.detail, {
      status: error.status,
      body: error,
      code: error.code,
      nextAction: error.nextAction,
      links: error.links,
    });
  }
  const status = response?.status ?? 0;
  const message =
    structuredErrorMessage(error) ?? response?.statusText ?? "Dashboard request failed";
  return new DashboardApiError(message, { status, body: error });
}

function generatedData<T>(result: GeneratedResult<T>): T {
  if (result.data !== undefined) return result.data;
  throw apiError(result.error, result.response);
}

function generatedVersionedData<T>(result: GeneratedResult<T>): VersionedDashboardResource<T> {
  const data = generatedData(result);
  const etag = result.response?.headers.get("etag");
  if (!etag) {
    throw new DashboardApiError("The Current Host omitted the required resource validator.", {
      status: 502,
      body: { code: "DASHBOARD_ETAG_MISSING" },
      code: "DASHBOARD_ETAG_MISSING",
    });
  }
  return { data, etag };
}

export async function adminV2GetHost(
  options: DashboardRequestOptions = {},
): Promise<AdminV2GetHostResponse> {
  return generatedData<AdminV2GetHostResponse>(
    await generatedAdminV2GetHost({ client: dashboardAdminClient(), signal: options.signal }),
  );
}

export async function adminV2CreateRuntimeRestart(
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2CreateRuntimeRestartResponse> {
  return generatedData<AdminV2CreateRuntimeRestartResponse>(
    await generatedAdminV2CreateRuntimeRestart({
      client: dashboardAdminClient(),
      body: {},
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-None-Match": "*",
      },
      signal: options.signal,
    }),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

export async function adminV2CreateCapletRecordFromDocument(
  id: string,
  document: string,
  intent: DashboardMutationIntent,
  historyLimit?: number,
  options: DashboardRequestOptions = {},
): Promise<AdminV2PutCapletRecordBundleResponse> {
  const bytes = new TextEncoder().encode(document);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const manifest = JSON.stringify({
    version: 1,
    files: [
      {
        path: "CAPLET.md",
        size: bytes.byteLength,
        sha256: bytesToHex(digest),
        executable: false,
      },
    ],
    ...(historyLimit === undefined ? {} : { historyLimit }),
  });
  const body = createOrderedBundleFormData(manifest, [
    new Blob([bytes], { type: "text/markdown" }),
  ]);
  return generatedData<AdminV2PutCapletRecordBundleResponse>(
    await generatedAdminV2PutCapletRecordBundleFormData({
      client: dashboardAdminClient(),
      path: { id },
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-None-Match": "*",
      },
      body,
      signal: options.signal,
    }),
  );
}

export async function adminV2GetRemoteClient(
  clientId: string,
  options: DashboardRequestOptions = {},
): Promise<VersionedDashboardResource<AdminV2GetRemoteClientResponse>> {
  return generatedVersionedData<AdminV2GetRemoteClientResponse>(
    await generatedAdminV2GetRemoteClient({
      client: dashboardAdminClient(),
      path: { clientId },
      signal: options.signal,
    }),
  );
}

export async function adminV2UpdateRemoteClient(
  clientId: string,
  body: AdminV2UpdateRemoteClientData["body"],
  etag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2UpdateRemoteClientResponse> {
  return generatedData<AdminV2UpdateRemoteClientResponse>(
    await generatedAdminV2UpdateRemoteClient({
      client: dashboardAdminClient(),
      path: { clientId },
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-Match": etag,
      },
      body,
      signal: options.signal,
    }),
  );
}

export async function adminV2GetRuntime(
  options: DashboardRequestOptions = {},
): Promise<AdminV2GetRuntimeResponse> {
  return generatedData<AdminV2GetRuntimeResponse>(
    await generatedAdminV2GetRuntime({ client: dashboardAdminClient(), signal: options.signal }),
  );
}

export async function adminV2ListLogs(
  options: DashboardRequestOptions & { limit?: number } = {},
): Promise<AdminV2ListLogsResponse> {
  return generatedData<AdminV2ListLogsResponse>(
    await generatedAdminV2ListLogs({
      client: dashboardAdminClient(),
      query: { limit: options.limit ?? 100, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2GetDiagnostics(
  options: DashboardRequestOptions = {},
): Promise<AdminV2GetDiagnosticsResponse> {
  return generatedData<AdminV2GetDiagnosticsResponse>(
    await generatedAdminV2GetDiagnostics({
      client: dashboardAdminClient(),
      signal: options.signal,
    }),
  );
}

export async function adminV2GetProjectBinding(
  options: DashboardRequestOptions = {},
): Promise<AdminV2GetProjectBindingResponse> {
  return generatedData<AdminV2GetProjectBindingResponse>(
    await generatedAdminV2GetProjectBinding({
      client: dashboardAdminClient(),
      signal: options.signal,
    }),
  );
}

export async function adminV2ListActivity(
  options: DashboardRequestOptions & { limit?: number } = {},
): Promise<AdminV2ListActivityResponse> {
  return generatedData<AdminV2ListActivityResponse>(
    await generatedAdminV2ListActivity({
      client: dashboardAdminClient(),
      query: { limit: options.limit ?? 50, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListEffectiveCaplets(
  options: DashboardListOptions = {},
): Promise<AdminV2ListEffectiveCapletsResponse> {
  return generatedData<AdminV2ListEffectiveCapletsResponse>(
    await generatedAdminV2ListEffectiveCaplets({
      client: dashboardAdminClient(),
      query: { cursor: options.cursor, limit: options.limit ?? 500, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListCatalogEntries(
  options: DashboardListOptions = {},
): Promise<AdminV2ListCatalogEntriesResponse> {
  return generatedData<AdminV2ListCatalogEntriesResponse>(
    await generatedAdminV2ListCatalogEntries({
      client: dashboardAdminClient(),
      query: {
        cursor: options.cursor,
        limit: options.limit ?? 500,
        sort: "desc",
        source: "official",
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2GetCatalogEntry(
  entryKey: string,
  options: DashboardRequestOptions = {},
): Promise<AdminV2GetCatalogEntryResponse> {
  return generatedData<AdminV2GetCatalogEntryResponse>(
    await generatedAdminV2GetCatalogEntry({
      client: dashboardAdminClient(),
      path: { entryKey },
      query: { source: "official" },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListCatalogUpdateCandidates(
  options: DashboardListOptions = {},
): Promise<AdminV2ListCatalogUpdateCandidatesResponse> {
  return generatedData<AdminV2ListCatalogUpdateCandidatesResponse>(
    await generatedAdminV2ListCatalogUpdateCandidates({
      client: dashboardAdminClient(),
      query: { cursor: options.cursor, limit: options.limit ?? 500, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2InstallCatalogCaplets(
  body: AdminV2InstallCatalogCapletsData["body"],
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2InstallCatalogCapletsResponse> {
  return generatedData<AdminV2InstallCatalogCapletsResponse>(
    await generatedAdminV2InstallCatalogCaplets({
      client: dashboardAdminClient(),
      body,
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-None-Match": "*",
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2UpdateCatalogCaplets(
  body: AdminV2UpdateCatalogCapletsData["body"],
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2UpdateCatalogCapletsResponse> {
  return generatedData<AdminV2UpdateCatalogCapletsResponse>(
    await generatedAdminV2UpdateCatalogCaplets({
      client: dashboardAdminClient(),
      body,
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-None-Match": "*",
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListRemoteClients(
  options: DashboardListOptions = {},
): Promise<AdminV2ListRemoteClientsResponse> {
  return generatedData<AdminV2ListRemoteClientsResponse>(
    await generatedAdminV2ListRemoteClients({
      client: dashboardAdminClient(),
      query: { cursor: options.cursor, limit: options.limit ?? 500, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2DeleteRemoteClient(
  clientId: string,
  etag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2DeleteRemoteClientResponse> {
  return generatedData<AdminV2DeleteRemoteClientResponse>(
    await generatedAdminV2DeleteRemoteClient({
      client: dashboardAdminClient(),
      path: { clientId },
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-Match": etag,
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListRemoteLoginRequests(
  options: DashboardListOptions = {},
): Promise<AdminV2ListRemoteLoginRequestsResponse> {
  return generatedData<AdminV2ListRemoteLoginRequestsResponse>(
    await generatedAdminV2ListRemoteLoginRequests({
      client: dashboardAdminClient(),
      query: { cursor: options.cursor, limit: options.limit ?? 500, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2GetRemoteLoginRequest(
  flowId: string,
  options: DashboardRequestOptions = {},
): Promise<VersionedDashboardResource<AdminV2GetRemoteLoginRequestResponse>> {
  return generatedVersionedData<AdminV2GetRemoteLoginRequestResponse>(
    await generatedAdminV2GetRemoteLoginRequest({
      client: dashboardAdminClient(),
      path: { flowId },
      signal: options.signal,
    }),
  );
}

export async function adminV2UpdateRemoteLoginRequest(
  flowId: string,
  body: AdminV2UpdateRemoteLoginRequestData["body"],
  etag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2UpdateRemoteLoginRequestResponse> {
  return generatedData<AdminV2UpdateRemoteLoginRequestResponse>(
    await generatedAdminV2UpdateRemoteLoginRequest({
      client: dashboardAdminClient(),
      path: { flowId },
      body,
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-Match": etag,
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListVaultValues(
  options: DashboardListOptions = {},
): Promise<AdminV2ListVaultValuesResponse> {
  return generatedData<AdminV2ListVaultValuesResponse>(
    await generatedAdminV2ListVaultValues({
      client: dashboardAdminClient(),
      query: { cursor: options.cursor, limit: options.limit ?? 500, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListVaultGrants(
  options: DashboardListOptions = {},
): Promise<AdminV2ListVaultGrantsResponse> {
  return generatedData<AdminV2ListVaultGrantsResponse>(
    await generatedAdminV2ListVaultGrants({
      client: dashboardAdminClient(),
      query: { cursor: options.cursor, limit: options.limit ?? 500, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2GetVaultValue(
  storedKey: string,
  options: DashboardRequestOptions = {},
): Promise<VersionedDashboardResource<AdminV2GetVaultValueResponse>> {
  return generatedVersionedData<AdminV2GetVaultValueResponse>(
    await generatedAdminV2GetVaultValue({
      client: dashboardAdminClient(),
      path: { storedKey },
      signal: options.signal,
    }),
  );
}

export async function adminV2PutVaultValue(
  storedKey: string,
  body: AdminV2PutVaultValueData["body"],
  etag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2PutVaultValueResponse> {
  const headers =
    etag === "*"
      ? { "Idempotency-Key": intent.idempotencyKey, "If-None-Match": "*" as const }
      : { "Idempotency-Key": intent.idempotencyKey, "If-Match": etag };
  return generatedData<AdminV2PutVaultValueResponse>(
    await generatedAdminV2PutVaultValue({
      client: dashboardAdminClient(),
      path: { storedKey },
      body,
      headers,
      signal: options.signal,
    }),
  );
}

export async function adminV2DeleteVaultValue(
  storedKey: string,
  etag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2DeleteVaultValueResponse> {
  return generatedData<AdminV2DeleteVaultValueResponse>(
    await generatedAdminV2DeleteVaultValue({
      client: dashboardAdminClient(),
      path: { storedKey },
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-Match": etag,
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListCapletRecords(
  options: DashboardListOptions = {},
): Promise<AdminV2ListCapletRecordsResponse> {
  return generatedData<AdminV2ListCapletRecordsResponse>(
    await generatedAdminV2ListCapletRecords({
      client: dashboardAdminClient(),
      query: { cursor: options.cursor, limit: options.limit ?? 500, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2GetCapletRecord(
  id: string,
  options: DashboardRequestOptions = {},
): Promise<VersionedDashboardResource<AdminV2GetCapletRecordResponse>> {
  return generatedVersionedData<AdminV2GetCapletRecordResponse>(
    await generatedAdminV2GetCapletRecord({
      client: dashboardAdminClient(),
      path: { id },
      signal: options.signal,
    }),
  );
}

export async function adminV2UpdateCapletRecord(
  id: string,
  body: AdminV2UpdateCapletRecordData["body"],
  etag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2UpdateCapletRecordResponse> {
  return generatedData<AdminV2UpdateCapletRecordResponse>(
    await generatedAdminV2UpdateCapletRecord({
      client: dashboardAdminClient(),
      path: { id },
      body,
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-Match": etag,
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2DeleteCapletRecord(
  id: string,
  etag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2DeleteCapletRecordResponse> {
  return generatedData<AdminV2DeleteCapletRecordResponse>(
    await generatedAdminV2DeleteCapletRecord({
      client: dashboardAdminClient(),
      path: { id },
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-Match": etag,
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2ListCapletRecordRevisions(
  id: string,
  options: DashboardListOptions = {},
): Promise<AdminV2ListCapletRecordRevisionsResponse> {
  return generatedData<AdminV2ListCapletRecordRevisionsResponse>(
    await generatedAdminV2ListCapletRecordRevisions({
      client: dashboardAdminClient(),
      path: { id },
      query: { cursor: options.cursor, limit: options.limit ?? 500, sort: "desc" },
      signal: options.signal,
    }),
  );
}

export async function adminV2GetCapletRecordRevision(
  id: string,
  revisionKey: string,
  options: DashboardRequestOptions = {},
): Promise<VersionedDashboardResource<AdminV2GetCapletRecordRevisionResponse>> {
  return generatedVersionedData<AdminV2GetCapletRecordRevisionResponse>(
    await generatedAdminV2GetCapletRecordRevision({
      client: dashboardAdminClient(),
      path: { id, revisionKey },
      signal: options.signal,
    }),
  );
}

export async function adminV2PutCapletRecordCurrentRevision(
  id: string,
  revisionKey: string,
  etag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2PutCapletRecordCurrentRevisionResponse> {
  return generatedData<AdminV2PutCapletRecordCurrentRevisionResponse>(
    await generatedAdminV2PutCapletRecordCurrentRevision({
      client: dashboardAdminClient(),
      path: { id },
      body: { revisionKey },
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-Match": etag,
      },
      signal: options.signal,
    }),
  );
}

export async function adminV2DeleteCapletRecordRevision(
  id: string,
  revisionKey: string,
  revisionEtag: string,
  parentEtag: string,
  intent: DashboardMutationIntent,
  options: DashboardRequestOptions = {},
): Promise<AdminV2DeleteCapletRecordRevisionResponse> {
  return generatedData<AdminV2DeleteCapletRecordRevisionResponse>(
    await generatedAdminV2DeleteCapletRecordRevision({
      client: dashboardAdminClient(),
      path: { id, revisionKey },
      headers: {
        "Idempotency-Key": intent.idempotencyKey,
        "If-Match": revisionEtag,
        "X-Caplets-Parent-If-Match": parentEtag,
      },
      signal: options.signal,
    }),
  );
}

export function isDashboardUnauthorized(error: unknown): boolean {
  return error instanceof DashboardApiError && error.status === 401;
}

function parseResponseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function structuredErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if ("detail" in value && typeof value.detail === "string") return value.detail;
  if ("message" in value && typeof value.message === "string") return value.message;
  if ("error" in value) return structuredErrorMessage(value.error);
  return undefined;
}

async function handwrittenDashboardRequest(
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const method = (options.method ?? "GET").toUpperCase();
  const response = await fetch(dashboardApiUrl(path), {
    ...options,
    credentials: "same-origin",
    headers: dashboardRequestHeaders(method, options.headers),
  });
  const body = parseResponseBody(await response.text());
  if (!response.ok) throw apiError(body, response);
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidHandwrittenResponse(message: string, body: unknown): DashboardApiError {
  return new DashboardApiError(message, {
    status: 502,
    body,
    code: "DASHBOARD_SESSION_RESPONSE_INVALID",
  });
}

function parseDashboardSession(value: unknown, body: unknown): DashboardSession {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.operatorClientId !== "string" ||
    typeof value.csrfToken !== "string" ||
    (value.role !== undefined && typeof value.role !== "string")
  ) {
    throw invalidHandwrittenResponse(
      "The Current Host returned an invalid dashboard session.",
      body,
    );
  }
  return {
    sessionId: value.sessionId,
    operatorClientId: value.operatorClientId,
    csrfToken: value.csrfToken,
    ...(value.role === undefined ? {} : { role: value.role }),
  };
}

export type DashboardLoginPending = {
  flowId: string;
  pendingCompletionSecret: string;
  intervalSeconds: number;
  approvalCommand: string;
};

export async function restoreDashboardSession(
  options: DashboardRequestOptions = {},
): Promise<{ authenticated: boolean; session: DashboardSession }> {
  const body = await handwrittenDashboardRequest("session", { signal: options.signal });
  if (!isRecord(body) || typeof body.authenticated !== "boolean") {
    throw invalidHandwrittenResponse(
      "The Current Host returned an invalid session restoration response.",
      body,
    );
  }
  return {
    authenticated: body.authenticated,
    session: parseDashboardSession(body.session, body),
  };
}

export async function startDashboardLogin(
  clientLabel: string,
  options: DashboardRequestOptions = {},
): Promise<DashboardLoginPending> {
  const body = await handwrittenDashboardRequest("login/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientLabel }),
    signal: options.signal,
  });
  if (
    !isRecord(body) ||
    typeof body.flowId !== "string" ||
    typeof body.pendingCompletionSecret !== "string" ||
    typeof body.intervalSeconds !== "number" ||
    typeof body.approvalCommand !== "string"
  ) {
    throw invalidHandwrittenResponse(
      "The Current Host returned an invalid login start response.",
      body,
    );
  }
  return {
    flowId: body.flowId,
    pendingCompletionSecret: body.pendingCompletionSecret,
    intervalSeconds: body.intervalSeconds,
    approvalCommand: body.approvalCommand,
  };
}

export async function pollDashboardLogin(
  flowId: string,
  pendingCompletionSecret: string,
  options: DashboardRequestOptions = {},
): Promise<{ status: string }> {
  const body = await handwrittenDashboardRequest("login/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId, pendingCompletionSecret }),
    signal: options.signal,
  });
  if (!isRecord(body) || typeof body.status !== "string") {
    throw invalidHandwrittenResponse(
      "The Current Host returned an invalid login polling response.",
      body,
    );
  }
  return { status: body.status };
}

export async function completeDashboardLogin(
  flowId: string,
  pendingCompletionSecret: string,
  options: DashboardRequestOptions = {},
): Promise<{ session: DashboardSession }> {
  const body = await handwrittenDashboardRequest("login/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId, pendingCompletionSecret }),
    signal: options.signal,
  });
  if (!isRecord(body)) {
    throw invalidHandwrittenResponse(
      "The Current Host returned an invalid login completion response.",
      body,
    );
  }
  return { session: parseDashboardSession(body.session, body) };
}

export async function logoutDashboardSession(options: DashboardRequestOptions = {}): Promise<void> {
  await handwrittenDashboardRequest("logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: options.signal,
  });
}

function parseRevealResponse(value: unknown): { value: string } {
  if (isRecord(value) && typeof value.value === "string") return { value: value.value };
  throw new DashboardApiError("The Current Host returned an invalid Vault reveal response.", {
    status: 502,
    body: value,
    code: "DASHBOARD_REVEAL_RESPONSE_INVALID",
  });
}

export async function revealVaultValue(
  key: string,
  confirmation: string,
  options: DashboardRequestOptions = {},
): Promise<{ value: string }> {
  const body = await handwrittenDashboardRequest("private/vault-reveals", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, confirmation }),
    signal: options.signal,
  });
  return parseRevealResponse(body);
}
