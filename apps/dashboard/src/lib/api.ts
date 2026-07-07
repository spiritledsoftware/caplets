import { dashboardApiUrl } from "./paths";

export type DashboardSession = {
  sessionId: string;
  operatorClientId: string;
  csrfToken: string;
  role?: string;
};

let activeSession: DashboardSession | undefined;

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

function apiErrorMessage(body: unknown, response: Response): string {
  const envelopeMessage = structuredErrorMessage(body);
  return envelopeMessage ?? `${response.status} ${response.statusText}`;
}

function structuredErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;

  const record = value as { error?: unknown; message?: unknown };
  if (typeof record.message === "string") return record.message;
  return structuredErrorMessage(record.error);
}
