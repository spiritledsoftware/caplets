import { CapletsError, toSafeError } from "../errors";

export type RemoteCliTransportDiscovery = { kind: "v2"; adminBaseUrl: URL } | { kind: "legacy-v1" };

export type RemoteCliDiscoveryOptions = {
  baseUrl: URL;
  fetch?: typeof fetch;
};

type VersionAdvertisement = {
  version: number;
  path: URL;
  admin: URL;
};

/**
 * Selects Admin v2 only after both discovery documents explicitly advertise it.
 * A frozen-v1 result is returned only for a complete, unambiguous v1-only service.
 */
export async function discoverRemoteCliTransport(
  options: RemoteCliDiscoveryOptions,
): Promise<RemoteCliTransportDiscovery> {
  const baseUrl = safeServiceBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const root = await fetchDiscoveryDocument(baseUrl, fetchImpl, "service");
  const versions = parseServiceDiscovery(root, baseUrl);
  const advertisedV2 = versions.find((entry) => entry.version === 2);
  if (advertisedV2) {
    const version = parseVersionDiscovery(
      await fetchDiscoveryDocument(advertisedV2.path, fetchImpl, "version 2"),
      baseUrl,
    );
    if (
      version.version !== 2 ||
      version.path.href !== advertisedV2.path.href ||
      version.admin.href !== advertisedV2.admin.href
    ) {
      throw invalidDiscovery("Caplets v2 discovery does not match the root advertisement.");
    }
    return { kind: "v2", adminBaseUrl: baseUrl };
  }

  const advertisedV1 = versions.find((entry) => entry.version === 1);
  if (!advertisedV1 || versions.some((entry) => entry.version !== 1)) {
    throw invalidDiscovery("Caplets discovery does not prove v2 or frozen v1 compatibility.");
  }
  const version = parseVersionDiscovery(
    await fetchDiscoveryDocument(advertisedV1.path, fetchImpl, "version 1"),
    baseUrl,
  );
  if (
    version.version !== 1 ||
    version.path.href !== advertisedV1.path.href ||
    version.admin.href !== advertisedV1.admin.href
  ) {
    throw invalidDiscovery("Caplets v1 discovery does not match the root advertisement.");
  }
  return { kind: "legacy-v1" };
}

async function fetchDiscoveryDocument(
  url: URL,
  fetchImpl: typeof fetch,
  label: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
  } catch (error) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Could not fetch Caplets ${label} discovery from ${safeUrl(url)}.`,
      toSafeError(error, "SERVER_UNAVAILABLE"),
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new CapletsError("AUTH_FAILED", `Caplets ${label} discovery authentication failed.`);
  }
  if (!response.ok) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Caplets ${label} discovery returned HTTP ${response.status}.`,
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw invalidDiscovery(`Caplets ${label} discovery is not valid JSON.`, error);
  }
}

function parseServiceDiscovery(value: unknown, baseUrl: URL): VersionAdvertisement[] {
  if (!isRecord(value)) throw invalidDiscovery("Caplets service discovery is malformed.");
  if (
    value.name !== "caplets" ||
    value.transport !== "http" ||
    typeof value.base !== "string" ||
    !Array.isArray(value.versions) ||
    value.versions.length === 0 ||
    !isRecord(value.auth) ||
    typeof value.auth.type !== "string"
  ) {
    throw invalidDiscovery("Caplets service discovery is malformed.");
  }
  const advertisedBase = safeDiscoveredUrl(value.base, baseUrl, "service base");
  if (normalizePath(advertisedBase.pathname) !== normalizePath(baseUrl.pathname)) {
    throw invalidDiscovery("Caplets service discovery advertises a different service base.");
  }
  const seen = new Set<number>();
  return value.versions.map((entry) => {
    const parsed = parseVersionDiscovery(entry, baseUrl);
    if (seen.has(parsed.version)) {
      throw invalidDiscovery(
        `Caplets service discovery advertises version ${parsed.version} twice.`,
      );
    }
    seen.add(parsed.version);
    return parsed;
  });
}

function parseVersionDiscovery(value: unknown, baseUrl: URL): VersionAdvertisement {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.path !== "string" ||
    !isRecord(value.links) ||
    typeof value.links.admin !== "string"
  ) {
    throw invalidDiscovery("Caplets version discovery is malformed.");
  }
  const version = value.version as number;
  const path = safeDiscoveredUrl(value.path, baseUrl, `version ${version} path`);
  const admin = safeDiscoveredUrl(value.links.admin, baseUrl, `version ${version} Admin link`);
  const expectedVersionPath = `${normalizePath(baseUrl.pathname)}/v${version}`;
  if (normalizePath(path.pathname) !== expectedVersionPath) {
    throw invalidDiscovery(`Caplets version ${version} path is not canonical.`);
  }
  if (normalizePath(admin.pathname) !== `${expectedVersionPath}/admin`) {
    throw invalidDiscovery(`Caplets version ${version} Admin link is not canonical.`);
  }
  return { version, path, admin };
}

function safeDiscoveredUrl(value: string, baseUrl: URL, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value, baseUrl);
  } catch (error) {
    throw invalidDiscovery(`Caplets ${label} is not a valid URL.`, error);
  }
  if (
    parsed.origin !== baseUrl.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !pathWithinBase(parsed.pathname, baseUrl.pathname)
  ) {
    throw invalidDiscovery(`Caplets ${label} escapes the selected remote service.`);
  }
  return parsed;
}

function safeServiceBaseUrl(value: URL): URL {
  const baseUrl = new URL(value.href);
  baseUrl.username = "";
  baseUrl.password = "";
  baseUrl.search = "";
  baseUrl.hash = "";
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
  return baseUrl;
}

function pathWithinBase(path: string, base: string): boolean {
  const normalizedBase = `${normalizePath(base)}/`;
  const normalizedPath = normalizePath(path);
  return normalizedPath === normalizePath(base) || normalizedPath.startsWith(normalizedBase);
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\/+$/u, "");
  return normalized || "";
}

function safeUrl(url: URL): string {
  const safe = new URL(url.href);
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}

function invalidDiscovery(message: string, cause?: unknown): CapletsError {
  return new CapletsError(
    "DOWNSTREAM_PROTOCOL_ERROR",
    message,
    cause === undefined ? undefined : toSafeError(cause, "DOWNSTREAM_PROTOCOL_ERROR"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
