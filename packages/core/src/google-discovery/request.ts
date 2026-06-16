import type { GoogleDiscoveryApiConfig } from "../config";
import { FORBIDDEN_HEADERS, isAllowedRemoteUrl } from "../config/validation";
import { CapletsError } from "../errors";
import type { GoogleDiscoveryOperation } from "./operations";

export function buildGoogleDiscoveryUrl(
  api: GoogleDiscoveryApiConfig,
  operation: GoogleDiscoveryOperation,
  args: Record<string, unknown>,
): URL {
  const base = api.baseUrl;
  validateBaseUrl(api, base);
  const url = buildOperationUrl(
    base,
    substitutePath(operation.path, asRecord(args.path), operation),
  );
  for (const [key, value] of Object.entries(asRecord(args.query))) {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, serializeGoogleDiscoveryValue("query", key, value));
    }
  }
  return url;
}

export function buildJsonRequestInit(
  operation: GoogleDiscoveryOperation,
  args: Record<string, unknown>,
  headers: Headers,
): RequestInit {
  for (const [key, value] of Object.entries(asRecord(args.header))) {
    if (value !== undefined && value !== null) {
      const normalized = key.toLowerCase();
      if (FORBIDDEN_HEADERS.has(normalized)) {
        throw new CapletsError("REQUEST_INVALID", `Header ${key} cannot be supplied by arguments`);
      }
      headers.set(key, serializeGoogleDiscoveryValue("header", key, value));
    }
  }
  if ("body" in args) {
    headers.set("content-type", "application/json");
    return {
      method: operation.method.toUpperCase(),
      headers,
      body: JSON.stringify(args.body),
      redirect: "manual",
    };
  }
  return { method: operation.method.toUpperCase(), headers, redirect: "manual" };
}

function validateBaseUrl(
  api: GoogleDiscoveryApiConfig,
  base: string | undefined,
): asserts base is string {
  if (!base) {
    throw new CapletsError("CONFIG_INVALID", `${api.server} is missing Google Discovery baseUrl`);
  }
  if (!isAllowedRemoteUrl(base)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${api.server} Google Discovery baseUrl is not allowed`,
    );
  }
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${api.server} Google Discovery baseUrl must not include credentials, query, or fragment`,
    );
  }
}

function buildOperationUrl(base: string, operationPath: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(operationPath) || operationPath.startsWith("//")) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Google Discovery operation path cannot change origin",
    );
  }
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/u, "");
  const relativePath = operationPath.replace(/^\/+/u, "");
  assertSafeRelativePath(relativePath);
  baseUrl.pathname = [basePath, relativePath].filter(Boolean).join("/");
  assertInsideBasePath(baseUrl, basePath);
  return baseUrl;
}

function substitutePath(
  path: string,
  values: Record<string, unknown>,
  operation: GoogleDiscoveryOperation,
): string {
  return path.replace(/\{([^}]+)\}/gu, (_match, expression: string) => {
    const reserved = expression.startsWith("+");
    const name = reserved ? expression.slice(1) : expression;
    const value = values[name];
    if (value === undefined || value === null || value === "") {
      throw new CapletsError("REQUEST_INVALID", `Missing required path parameter ${name}`, {
        tool: operation.name,
      });
    }
    const serialized = serializeGoogleDiscoveryValue("path", name, value);
    return reserved ? encodeReservedPathValue(serialized) : encodeURIComponent(serialized);
  });
}

function encodeReservedPathValue(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function assertSafeRelativePath(path: string): void {
  for (const segment of path.split("/")) {
    const decoded = safeDecodePathSegment(segment);
    if (decoded === "." || decoded === "..") {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Google Discovery operation path cannot escape baseUrl",
      );
    }
  }
}

function assertInsideBasePath(url: URL, basePath: string): void {
  const normalizedBase = basePath === "" ? "/" : `${basePath}/`;
  if (normalizedBase === "/") return;
  const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  if (pathname !== normalizedBase && !pathname.startsWith(normalizedBase)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Google Discovery operation path cannot escape baseUrl",
    );
  }
}

function safeDecodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function serializeGoogleDiscoveryValue(
  location: "path" | "query" | "header",
  name: string,
  value: unknown,
): string {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return String(value);
    default:
      throw new CapletsError(
        "REQUEST_INVALID",
        `Google Discovery ${location} parameter ${name} must be a string, number, or boolean`,
      );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
