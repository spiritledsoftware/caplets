import { dashboardApiUrl, dashboardBasePath } from "./paths";

export type DashboardSession = {
  sessionId: string;
  operatorClientId: string;
  csrfToken: string;
  role?: string;
};

export type DashboardStorageHealth = {
  backend?: "sqlite" | "postgres";
  authorityToken?: { authorityGeneration?: number; effectiveGeneration?: number };
  readiness?: "ready" | "not-ready" | "stale-read-only";
  connectivity?: "connected" | "unavailable";
  migration?: "current" | "blocked";
  bootstrapCompatibility?: "current" | "staged" | "incompatible";
  staleAgeMs?: number;
  convergence?: "single-node" | "within-budget" | "pending" | "overdue";
  guidanceCode?: string;
  error?: string;
};

export type DashboardManagementMutation =
  | {
      kind: "caplet-set-activation";
      id: string;
      activation: "active" | "setup-required" | "dormant-shadowed" | "disabled";
      selector: "effective" | "underlying-sql";
      expectedAggregateVersion?: number | undefined;
      expectedAuthorityToken?:
        | { authorityGeneration: number; effectiveGeneration: number }
        | undefined;
    }
  | {
      kind: "host-setting-set";
      key: string;
      value: unknown;
      selector: "effective" | "underlying-sql";
      expectedAggregateVersion?: number | undefined;
      expectedAuthorityToken?:
        | { authorityGeneration: number; effectiveGeneration: number }
        | undefined;
    };

export type DashboardManagementBinding = {
  operationId: string;
  target: "global" | "remote";
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  actorId: string;
  requestIdentity: string;
  operationClass: "logical-state" | "security-authority" | "external-effect";
};

export type DashboardManagementOperation = {
  operationId: string;
  requestIdentity: string;
  mutation: DashboardManagementMutation;
  binding?: DashboardManagementBinding | undefined;
};

export type PendingDashboardManagementOperation = {
  operationId: string;
  binding: DashboardManagementBinding;
  target: {
    resource: "caplet" | "host-setting";
    id: string;
    selector: "effective" | "underlying-sql";
  };
};

export type DashboardManagementMutationResult =
  | {
      status: "committed";
      binding: Record<string, unknown>;
      receipt: Record<string, unknown>;
      localApplicationError?: { code?: string; message?: string } | undefined;
    }
  | {
      status: "unknown";
      operation: PendingDashboardManagementOperation;
      retryAllowed: false;
      guidance: "lookup-original-target";
    }
  | Record<string, unknown>;

const PENDING_MANAGEMENT_STORAGE_KEY = "caplets-dashboard-pending-management-v2";
const RECOVERED_MANAGEMENT_STORAGE_KEY = "caplets-dashboard-recovered-management-v1";
let activeSession: DashboardSession | undefined;
const RECOVERY_ACKNOWLEDGED_STORAGE_KEY = "caplets-dashboard-recovered-management-acknowledged-v1";

export class DashboardApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, options: { status: number; body: unknown }) {
    super(message);
    this.name = "DashboardApiError";
    this.status = options.status;
    this.body = options.body;
  }
}

export function setDashboardSession(session: DashboardSession | undefined) {
  activeSession = session;
}

export function csrfHeaders(session = activeSession): HeadersInit {
  return session?.csrfToken ? { "x-caplets-csrf": session.csrfToken } : {};
}

export async function dashboardApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(dashboardApiUrl(path), {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...csrfHeaders(),
      ...options.headers,
    },
    ...options,
  });
  const text = await response.text();
  const body = parseResponseBody(text);
  if (!response.ok) {
    throw new DashboardApiError(apiErrorMessage(body, response), { status: response.status, body });
  }
  return body as T;
}

export async function dashboardStorageHealth(
  options: RequestInit = {},
): Promise<DashboardStorageHealth> {
  const response = await fetch(dashboardHealthUrl(), {
    credentials: "same-origin",
    ...options,
  });
  const body = parseResponseBody(await response.text());
  if (response.status !== 200 && response.status !== 503) {
    throw new DashboardApiError(apiErrorMessage(body, response), {
      status: response.status,
      body,
    });
  }
  if (
    isDashboardStorageHealth(body) &&
    ((response.status === 200 && body.readiness === "ready") ||
      (response.status === 503 && body.readiness !== "ready"))
  ) {
    return body;
  }
  return unavailableDashboardStorageHealth(body, response.status);
}

export async function dashboardManagementPreview(mutation: DashboardManagementMutation): Promise<{
  operation: DashboardManagementOperation;
  result: Record<string, unknown>;
}> {
  return prepareDashboardManagementOperation({
    operationId: `operation_${crypto.randomUUID()}`,
    requestIdentity: crypto.randomUUID(),
    mutation,
  });
}

async function prepareDashboardManagementOperation(
  operation: DashboardManagementOperation,
): Promise<{ operation: DashboardManagementOperation; result: Record<string, unknown> }> {
  const result = await dashboardApi<Record<string, unknown>>("management/preview", {
    method: "POST",
    body: JSON.stringify(operation),
  });
  if (!isApiRecord(result) || result.status !== "preview") {
    throw new DashboardApiError("Current Host management preview is unavailable.", {
      status: 503,
      body: result,
    });
  }
  const binding = parseManagementBinding(result.binding);
  const authorityToken = parseAuthorityToken(result.authorityToken);
  return {
    result,
    operation: {
      ...operation,
      binding,
      mutation: authorityToken
        ? { ...operation.mutation, expectedAuthorityToken: authorityToken }
        : operation.mutation,
    },
  };
}

export async function dashboardManagementMutation(
  mutation: DashboardManagementMutation,
  preparedOperation?: DashboardManagementOperation | undefined,
): Promise<DashboardManagementMutationResult> {
  let operation: DashboardManagementOperation = preparedOperation ?? {
    operationId: `operation_${crypto.randomUUID()}`,
    requestIdentity: crypto.randomUUID(),
    mutation,
  };
  if (!operation.binding) {
    const prepared = await prepareDashboardManagementOperation(operation);
    if (prepared.result.status !== "preview") return prepared.result;
    operation = prepared.operation;
  }
  const pendingOperation = retainPendingManagementOperation(operation);
  try {
    const result = await dashboardApi<DashboardManagementMutationResult>("management/mutate", {
      method: "POST",
      body: JSON.stringify(operation),
    });
    if (result.status !== "unknown") removePendingManagementOperation(operation.operationId);
    return result;
  } catch (error) {
    if (error instanceof DashboardApiError && error.status < 500) {
      removePendingManagementOperation(operation.operationId);
      throw error;
    }
    return {
      status: "unknown",
      operation: pendingOperation,
      retryAllowed: false,
      guidance: "lookup-original-target",
    };
  }
}

export async function recoverDashboardManagementOperations(): Promise<unknown[]> {
  const pending = pendingManagementOperations();
  const priorOutcomes = recoveredManagementOperations();
  const outcomes: unknown[] = [];
  const terminalOutcomes: unknown[] = [];
  for (const operation of pending) {
    try {
      const outcome = await dashboardApi<Record<string, unknown>>("management/operations/lookup", {
        method: "POST",
        body: JSON.stringify({ binding: operation.binding }),
      });
      outcomes.push(outcome);
      if (outcome.status === "committed" || outcome.status === "not_committed") {
        terminalOutcomes.push(outcome);
        removePendingManagementOperation(operation.operationId);
      }
    } catch (error) {
      if (error instanceof DashboardApiError) {
        const outcome = dashboardManagementLookupFailure(error, operation);
        if (!outcome) throw error;
        outcomes.push(outcome);
        continue;
      }
      outcomes.push({
        status: "unknown",
        operation,
        retryAllowed: false,
        guidance: "lookup-original-target",
      });
    }
  }
  if (terminalOutcomes.length && typeof localStorage !== "undefined") {
    localStorage.removeItem(RECOVERY_ACKNOWLEDGED_STORAGE_KEY);
    localStorage.setItem(
      RECOVERED_MANAGEMENT_STORAGE_KEY,
      JSON.stringify([...priorOutcomes, ...terminalOutcomes].slice(-20)),
    );
  }
  return [...priorOutcomes, ...outcomes];
}

export function acknowledgeRecoveredDashboardManagementOperations(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(RECOVERED_MANAGEMENT_STORAGE_KEY);
    localStorage.setItem(RECOVERY_ACKNOWLEDGED_STORAGE_KEY, "true");
  }
}

export function dashboardManagementRecoveryNoticesAcknowledged(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    localStorage.getItem(RECOVERY_ACKNOWLEDGED_STORAGE_KEY) === "true"
  );
}

function recoveredManagementOperations(): unknown[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(RECOVERED_MANAGEMENT_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function pendingManagementOperations(): PendingDashboardManagementOperation[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PENDING_MANAGEMENT_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(isPendingDashboardManagementOperation);
  } catch {
    return [];
  }
}

function retainPendingManagementOperation(
  operation: DashboardManagementOperation,
): PendingDashboardManagementOperation {
  if (!operation.binding) {
    throw new Error("A target-bound management operation is required for recovery.");
  }
  const pendingOperation: PendingDashboardManagementOperation = {
    operationId: operation.operationId,
    binding: operation.binding,
    target:
      operation.mutation.kind === "host-setting-set"
        ? {
            resource: "host-setting",
            id: operation.mutation.key,
            selector: operation.mutation.selector,
          }
        : {
            resource: "caplet",
            id: operation.mutation.id,
            selector: operation.mutation.selector,
          },
  };
  if (typeof localStorage === "undefined") return pendingOperation;
  const pending = pendingManagementOperations().filter(
    (entry) => entry.operationId !== operation.operationId,
  );
  localStorage.setItem(
    PENDING_MANAGEMENT_STORAGE_KEY,
    JSON.stringify([...pending, pendingOperation].slice(-20)),
  );
  return pendingOperation;
}

function removePendingManagementOperation(operationId: string): void {
  if (typeof localStorage === "undefined") return;
  const pending = pendingManagementOperations().filter(
    (entry) => entry.operationId !== operationId,
  );
  localStorage.setItem(PENDING_MANAGEMENT_STORAGE_KEY, JSON.stringify(pending));
}

function isPendingDashboardManagementOperation(
  value: unknown,
): value is PendingDashboardManagementOperation {
  if (!isApiRecord(value) || !isApiRecord(value.target)) return false;
  return (
    typeof value.operationId === "string" &&
    isManagementBinding(value.binding) &&
    value.binding.operationId === value.operationId &&
    (value.target.resource === "caplet" || value.target.resource === "host-setting") &&
    typeof value.target.id === "string" &&
    (value.target.selector === "effective" || value.target.selector === "underlying-sql")
  );
}

function parseManagementBinding(value: unknown): DashboardManagementBinding {
  if (!isManagementBinding(value))
    throw new DashboardApiError("Invalid management binding.", {
      status: 502,
      body: value,
    });
  return value;
}

function isManagementBinding(value: unknown): value is DashboardManagementBinding {
  return (
    isApiRecord(value) &&
    typeof value.operationId === "string" &&
    (value.target === "global" || value.target === "remote") &&
    typeof value.logicalHostId === "string" &&
    typeof value.storeId === "string" &&
    typeof value.operationNamespace === "string" &&
    typeof value.actorId === "string" &&
    typeof value.requestIdentity === "string" &&
    (value.operationClass === "logical-state" ||
      value.operationClass === "security-authority" ||
      value.operationClass === "external-effect")
  );
}

function parseAuthorityToken(
  value: unknown,
): { authorityGeneration: number; effectiveGeneration: number } | undefined {
  if (!isApiRecord(value)) return undefined;
  return Number.isSafeInteger(value.authorityGeneration) &&
    Number(value.authorityGeneration) >= 0 &&
    Number.isSafeInteger(value.effectiveGeneration) &&
    Number(value.effectiveGeneration) >= 0
    ? {
        authorityGeneration: Number(value.authorityGeneration),
        effectiveGeneration: Number(value.effectiveGeneration),
      }
    : undefined;
}

function dashboardManagementLookupFailure(
  error: DashboardApiError,
  operation: PendingDashboardManagementOperation,
): Record<string, unknown> | undefined {
  if (error.status !== 403 && error.status !== 409 && error.status !== 503) return undefined;
  const body = isApiRecord(error.body) ? error.body : { message: error.message };
  const status =
    typeof body.status === "string"
      ? body.status
      : error.status === 403
        ? "lookup_forbidden"
        : error.status === 409
          ? "lookup_conflict"
          : "lookup_unavailable";
  return {
    ...body,
    status,
    httpStatus: error.status,
    operation,
    retryAllowed: false,
    guidance: "lookup-original-target",
  };
}

function isDashboardStorageHealth(value: unknown): value is DashboardStorageHealth & {
  backend: "sqlite" | "postgres";
  authorityToken: { authorityGeneration: number; effectiveGeneration: number };
  readiness: "ready" | "not-ready" | "stale-read-only";
  connectivity: "connected" | "unavailable";
  migration: "current" | "blocked";
  bootstrapCompatibility: "current" | "staged" | "incompatible";
  convergence: "single-node" | "within-budget" | "pending" | "overdue";
  guidanceCode: string;
} {
  if (!isApiRecord(value) || !isApiRecord(value.authorityToken)) return false;
  const authorityGeneration = value.authorityToken.authorityGeneration;
  const effectiveGeneration = value.authorityToken.effectiveGeneration;
  if (
    !Number.isSafeInteger(authorityGeneration) ||
    Number(authorityGeneration) < 0 ||
    !Number.isSafeInteger(effectiveGeneration) ||
    Number(effectiveGeneration) < 0
  ) {
    return false;
  }
  if (value.backend !== "sqlite" && value.backend !== "postgres") {
    return false;
  }
  if (
    value.readiness !== "ready" &&
    value.readiness !== "not-ready" &&
    value.readiness !== "stale-read-only"
  ) {
    return false;
  }
  if (value.connectivity !== "connected" && value.connectivity !== "unavailable") return false;
  if (value.migration !== "current" && value.migration !== "blocked") return false;
  if (
    value.bootstrapCompatibility !== "current" &&
    value.bootstrapCompatibility !== "staged" &&
    value.bootstrapCompatibility !== "incompatible"
  ) {
    return false;
  }
  if (
    value.convergence !== "single-node" &&
    value.convergence !== "within-budget" &&
    value.convergence !== "pending" &&
    value.convergence !== "overdue"
  ) {
    return false;
  }
  if (
    value.guidanceCode !== "ok" &&
    value.guidanceCode !== "storage-unavailable" &&
    value.guidanceCode !== "migration-required" &&
    value.guidanceCode !== "convergence-pending" &&
    value.guidanceCode !== "convergence-overdue" &&
    value.guidanceCode !== "bootstrap-incompatible"
  ) {
    return false;
  }
  if (
    value.staleAgeMs !== undefined &&
    (typeof value.staleAgeMs !== "number" ||
      !Number.isFinite(value.staleAgeMs) ||
      value.staleAgeMs < 0)
  ) {
    return false;
  }
  if (value.readiness === "ready") {
    const convergenceReady =
      value.convergence === "single-node" || value.convergence === "within-budget";
    const convergencePending = value.convergence === "pending";
    return (
      value.connectivity === "connected" &&
      value.migration === "current" &&
      value.bootstrapCompatibility !== "incompatible" &&
      (convergenceReady || convergencePending) &&
      value.guidanceCode === (convergencePending ? "convergence-pending" : "ok") &&
      value.staleAgeMs === undefined
    );
  }
  if (value.readiness === "stale-read-only") {
    return (
      value.connectivity === "unavailable" &&
      value.guidanceCode === "storage-unavailable" &&
      value.staleAgeMs !== undefined
    );
  }
  return value.guidanceCode !== "ok";
}

function unavailableDashboardStorageHealth(body: unknown, status: number): DashboardStorageHealth {
  const backend =
    isApiRecord(body) && (body.backend === "sqlite" || body.backend === "postgres")
      ? body.backend
      : undefined;
  return {
    ...(backend ? { backend } : {}),
    readiness: "not-ready",
    connectivity: "unavailable",
    guidanceCode: "storage-unavailable",
    error: structuredErrorMessage(body) ?? `Storage health response was unavailable (${status}).`,
  };
}

function isApiRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isDashboardUnauthorized(error: unknown): boolean {
  return error instanceof DashboardApiError && error.status === 401;
}

function dashboardHealthUrl(): string {
  const segments = dashboardBasePath().split("/").filter(Boolean);
  segments.pop();
  return `/${[...segments, "v1", "healthz"].join("/")}`;
}

function parseResponseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function apiErrorMessage(body: unknown, response: Response): string {
  const envelopeMessage = structuredErrorMessage(body);
  return envelopeMessage ?? `${response.status} ${response.statusText}`;
}

function structuredErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isApiRecord(value)) return undefined;
  if (typeof value.message === "string") return value.message;
  return structuredErrorMessage(value.error);
}
